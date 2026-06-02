import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WORKSPACE, GUEST_WORKSPACE, FRIENDS_WORKSPACE, CHAT_TIMEOUT_MS, resolveModel, GROUP_CHATS } from '../config.js';
import { log } from '../util/logger.js';
import { parseStreamLine, type StreamCallbacks } from './stream-parser.js';
import { getSession, getOrCreate, touch, reset, addUsage } from './session-manager.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder.js';
import { trackActive, untrackActive } from './active-tracker.js';
import type { TopicConfig } from '../config.js';

/** Active child processes — tracked for graceful shutdown and per-topic stop */
const activeProcs = new Map<number, ChildProcess>();
let isShuttingDown = false;

/** Mark shutdown started — must be called before bot.stop() so child close handlers
 *  (triggered by systemd cgroup SIGTERM) don't wipe active-topics.json */
export function markShuttingDown(): void {
  isShuttingDown = true;
}

export function killAll(): void {
  isShuttingDown = true;
  for (const proc of activeProcs.values()) {
    proc.kill('SIGTERM');
  }
}

/** Kill the active Claude process for a specific topic. Returns true if one was running. */
export function stopTopic(topicId: number): boolean {
  const proc = activeProcs.get(topicId);
  if (proc) {
    proc.kill('SIGTERM');
    return true;
  }
  return false;
}

export interface RunResult {
  text: string;
  sessionId: string;
  error: string | null;
}

/**
 * Run claude -p for a topic message.
 *
 * - First message: creates session with --session-id + --append-system-prompt
 * - Subsequent: resumes with --resume (no system prompt re-injection)
 *
 * Returns streaming callbacks for progressive Telegram editing.
 */
export async function runClaude(
  topicId: number,
  topicConfig: TopicConfig,
  userMessage: string,
  attachments: string[] = [],
  onDelta?: (accumulated: string) => void,
  onToolUse?: (toolName: string, input: string) => void,
  systemPromptOverride?: string,
  onThinking?: (text: string) => void,
  isGroupChat: boolean = false,
): Promise<RunResult> {
  const existing = getSession(topicId);
  const isResume = existing !== null && existing.messageCount > 0;
  const entry = getOrCreate(topicId, topicConfig.model ?? 'sonnet');

  // Turn number for this user message (1-indexed). `entry.messageCount` is the
  // count *before* this turn; touch() increments it after the run completes.
  const turnNumber = entry.messageCount + 1;
  const prompt = buildUserPrompt(topicConfig, topicId, userMessage, attachments, isGroupChat, turnNumber);

  const workDir = topicConfig.workspace || WORKSPACE;
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages', // streams text_delta + thinking_delta — required for live "thinking" display
    '--model', resolveModel(entry.model),
    '--permission-mode', 'bypassPermissions',
    '--add-dir', workDir,
  ];

  // Only pass --effort when explicitly set (not 'auto')
  const effort = entry.effort || 'auto';
  if (effort !== 'auto') {
    args.push('--effort', effort);
  }

  if (isResume) {
    args.push('--resume', entry.sessionId);
  } else {
    args.push('--session-id', entry.sessionId);
    const sysPrompt = systemPromptOverride || buildSystemPrompt(topicConfig);
    args.push('--append-system-prompt', sysPrompt);
  }

  // Use stdin for long prompts to avoid OS argv limits (~128KB-2MB)
  const useStdin = Buffer.byteLength(prompt) > 100_000;
  if (!useStdin) {
    args.push(prompt);
  }

  log.info(`Claude ${isResume ? 'resume' : 'create'} topic=${topicConfig.name} session=${entry.sessionId.slice(0, 8)}...${useStdin ? ' (stdin)' : ''}`);

  // Track for auto-resume on restart
  const chatId = topicConfig.workspace === GUEST_WORKSPACE ? (process.env.GUEST_CHAT_ID || '') : (process.env.CHAT_ID || '');
  const threadId = topicId || null;
  trackActive(topicId, topicConfig.name, chatId, threadId, userMessage);

  // Expose the originating Telegram chat id to spawned tools (e.g. per-chat rate limits).
  let clawChatId: string;
  if (topicConfig.workspace === GUEST_WORKSPACE) {
    clawChatId = process.env.GUEST_CHAT_ID || '';
  } else if (topicConfig.workspace === FRIENDS_WORKSPACE) {
    const friendsCfg = Object.values(GROUP_CHATS).find(g => g.workspace === FRIENDS_WORKSPACE);
    clawChatId = friendsCfg?.chatId ?? '';
  } else {
    clawChatId = process.env.CHAT_ID || '';
  }

  // Forum thread id for claw-ask routing. Only meaningful for the owner/Guest DM
  // topics where topicId is the actual message_thread_id; groups use abs(chat_id)
  // as a session key and have no thread, so we pass empty.
  const isGroupWorkspace = topicConfig.workspace === FRIENDS_WORKSPACE;
  const clawThreadId = (!isGroupWorkspace && topicId > 0) ? String(topicId) : '';

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn('/root/.local/bin/claude', args, {
      cwd: workDir,
      env: { ...process.env, HOME: '/root', IS_SANDBOX: '1', CLAW_CHAT_ID: clawChatId, CLAW_THREAD_ID: clawThreadId },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeProcs.set(topicId, child);

    let accumulated = '';
    let resultText = '';
    let resultSessionId = entry.sessionId;
    let resultError: string | null = null;
    let stderr = '';

    // Guard: 'error' and 'close' can both fire for a single process. Ensure the
    // activeProcs delete + untrackActive teardown runs exactly once.
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timer);
      activeProcs.delete(topicId);
      if (!isShuttingDown) untrackActive(topicId);
    };

    // Timeout
    const timer = setTimeout(() => {
      log.warn(`Claude timeout for topic ${topicConfig.name} after ${CHAT_TIMEOUT_MS}ms`);
      child.kill('SIGTERM');
      resultError = 'Response timed out. Try again or /clear to reset.';
    }, CHAT_TIMEOUT_MS);

    // Parse NDJSON stream line by line
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      parseStreamLine(line, {
        onDelta(text) {
          accumulated += text;
          onDelta?.(accumulated);
        },
        onComplete(fullText, sessionId, usage) {
          resultText = fullText || accumulated;
          if (sessionId) resultSessionId = sessionId;
          if (usage) {
            addUsage(topicId, usage.costUsd, usage.inputTokens, usage.outputTokens);
          }
        },
        onToolUse(toolName, input) {
          onToolUse?.(toolName, input);
        },
        onThinking(text) {
          onThinking?.(text);
        },
        onError(error) {
          resultError = error;
        },
      });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      cleanup();

      if (code !== 0 && !resultError) {
        log.error(`Claude exited ${code} for topic ${topicConfig.name}`, stderr.slice(0, 500));
        resultError = resultError || `Claude process exited with code ${code}`;
      }

      // Use accumulated text if result event wasn't received
      const finalText = resultText || accumulated;

      if (!resultError) {
        touch(topicId);
      }

      resolve({
        text: finalText,
        sessionId: resultSessionId,
        error: resultError,
      });
    });

    child.on('error', (err) => {
      cleanup();
      log.error(`Claude spawn error for topic ${topicConfig.name}:`, err.message);
      resolve({
        text: '',
        sessionId: resultSessionId,
        error: `Failed to start Claude: ${err.message}`,
      });
    });

    // Write prompt via stdin if too long for argv, otherwise close immediately
    if (useStdin) {
      child.stdin.write(prompt);
    }
    child.stdin.end();
  });
}

/**
 * Retry with fresh session if resume fails.
 */
export async function runClaudeWithRetry(
  topicId: number,
  topicConfig: TopicConfig,
  userMessage: string,
  attachments: string[] = [],
  onDelta?: (accumulated: string) => void,
  onToolUse?: (toolName: string, input: string) => void,
  systemPromptOverride?: string,
  onThinking?: (text: string) => void,
  isGroupChat: boolean = false,
): Promise<RunResult> {
  let result = await runClaude(topicId, topicConfig, userMessage, attachments, onDelta, onToolUse, systemPromptOverride, onThinking, isGroupChat);

  // If session error (stale UUID, corruption), reset and retry once with fresh session
  if (result.error && (
    result.error.includes('session') ||
    result.error.includes('resume') ||
    result.error.includes('Session ID') ||
    result.error.includes('already in use')
  )) {
    log.warn(`Session error for topic ${topicConfig.name}, resetting and retrying...`);
    reset(topicId);
    result = await runClaude(topicId, topicConfig, userMessage, attachments, onDelta, onToolUse, systemPromptOverride, onThinking, isGroupChat);
  }

  return result;
}
