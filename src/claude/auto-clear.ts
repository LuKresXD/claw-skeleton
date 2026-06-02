import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { listSessions, reset, getSession } from './session-manager.js';
import { isActive } from './active-tracker.js';
import { summarizeAndSave } from '../bot/commands.js';
import {
  TOPICS, GUEST_TOPICS, GROUP_CHATS, GUEST_CHAT_ID, WORKSPACE, CHAT_ID,
  AUTO_CLEAR_INTERVAL_MS, AUTO_CLEAR_EVAL_MIN_MS, AUTO_CLEAR_KEEP_TTL_MS,
  AUTO_CLEAR_HARD_BACKSTOP_MS, AUTO_CLEAR_EVAL_MODEL,
} from '../config.js';
import { log } from '../util/logger.js';

const CLAUDE_BIN = '/root/.local/bin/claude';
const EVAL_TIMEOUT_MS = 45_000;

// Cache of "keep" verdicts so we don't re-eval the same idle session every sweep.
// Keyed by topicId. expiresAt = when this verdict goes stale.
const keepCache = new Map<number, { until: number; reason: string }>();

type BotApi = {
  sendMessage(chatId: number | string, text: string, opts?: any): Promise<unknown>;
};

interface EvalResult {
  clear: boolean;
  reason: string;
}

/** Resolve display name for a topic/group ID */
function topicName(id: number): string {
  if (id === 0) return 'Incognito';
  const topic = TOPICS[id] || GUEST_TOPICS[id];
  if (topic) return topic.name;
  const group = Object.values(GROUP_CHATS).find(g => Math.abs(Number(g.chatId)) === id);
  if (group) return group.name;
  return `Topic-${id}`;
}

/** Resolve workspace + chat target for a topic. */
function resolveTopicTarget(id: number): { workDir: string; chatId: string; threadId: number | null } {
  const topicConfig = TOPICS[id] || GUEST_TOPICS[id];
  const groupConfig = !topicConfig
    ? Object.values(GROUP_CHATS).find(g => Math.abs(Number(g.chatId)) === id)
    : null;

  const workDir = topicConfig?.workspace || groupConfig?.workspace || WORKSPACE;
  const chatId = groupConfig
    ? groupConfig.chatId
    : (GUEST_TOPICS[id] ? GUEST_CHAT_ID : CHAT_ID);
  const threadId = groupConfig ? null : id;
  return { workDir, chatId, threadId };
}

/** Slugify workDir → claude transcripts dir, mirroring commands.ts */
function sessionDirForWorkDir(workDir: string): string {
  const slug = workDir.replace(/[/.]/g, '-');
  return resolve('/root/.claude/projects', slug);
}

/**
 * Read the tail of a session's transcript JSONL and render a short
 * USER/CLAW message log for eval. Returns null if the file is missing.
 */
function readTranscriptTail(sessionId: string, workDir: string, maxMessages = 30): string | null {
  const file = resolve(sessionDirForWorkDir(workDir), `${sessionId}.jsonl`);
  let lines: string[];
  try {
    // Drop blank lines so an empty trailing/interior line never reaches JSON.parse.
    lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return null;
  }

  const msgs: string[] = [];
  // Walk from the end backwards so we keep the most recent messages.
  for (let i = lines.length - 1; i >= 0 && msgs.length < maxMessages; i--) {
    try {
      const o = JSON.parse(lines[i]);
      let text = '';
      if (o.type === 'user') {
        const c = o.message?.content;
        text = typeof c === 'string'
          ? c
          : (c || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (text) text = `USER: ${text.slice(0, 400)}`;
      } else if (o.type === 'assistant') {
        const c = o.message?.content;
        text = (c || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (text) text = `CLAW: ${text.slice(0, 400)}`;
      }
      if (text) msgs.unshift(text);
    } catch (e: any) {
      // Skip malformed line, but surface it instead of swallowing silently.
      log.warn(`[auto-clear] ${sessionId}: skipping malformed transcript line ${i}: ${e?.message ?? e}`);
    }
  }

  if (msgs.length === 0) return null;
  return msgs.join('\n\n');
}

/**
 * Ask Claude (sonnet/opus, low effort) whether a session is safe to auto-clear.
 * Returns a strict {clear, reason} verdict.
 */
async function evaluateSessionState(
  topicLabel: string,
  idleHours: number,
  transcript: string,
): Promise<EvalResult> {
  const prompt = `You are deciding whether a Claude Code Telegram chat session can be safely auto-cleared.

Topic: ${topicLabel}
Idle: ${idleHours} hour(s) since last user message.

A session should CLEAR ("clear": true) when:
- The last exchange wrapped up cleanly (task shipped, question answered, user said thanks/cool/ok, or the topic naturally closed).
- Nothing in the transcript suggests the user is mid-task or waiting for follow-up.

A session should be KEPT ("clear": false) when:
- The last assistant message ended mid-task, mid-thought, or pending user verification.
- There is an explicit unanswered question, blocker, or "let me know when X" hanging.
- The work clearly spans multiple sessions (project build, debugging in progress, lecture review).

Be biased toward CLEAR when in doubt — the summarizer preserves context to memory either way, so a wrong "clear" loses nothing important. A wrong "keep" wastes tokens forever.

Return ONLY a single JSON object on one line, no prose:
{"clear": true|false, "reason": "<one short sentence>"}

Recent transcript (oldest -> newest):
<transcript>
${transcript}
</transcript>`;

  // Prompt is fed via stdin (NOT as trailing positional). Trailing positional
  // breaks when the prompt body contains '--' or quoted tokens that claude's
  // argv parser misinterprets as flags. stdin avoids the whole class of bugs.
  const args = [
    '-p',
    '--model', AUTO_CLEAR_EVAL_MODEL,
    '--effort', 'low',
    '--no-session-persistence',
    '--output-format', 'text',
    '--permission-mode', 'plan',
    '--disallowedTools', 'Read,Write,Edit,Bash,Grep,Glob,WebSearch,WebFetch,Task',
  ];

  const text = await new Promise<string>((resolveP) => {
    let settled = false;
    const finish = (s: string) => { if (!settled) { settled = true; resolveP(s); } };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      finish(`ERR: spawn failed ${e.message}`);
      return;
    }
    let out = ''; let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(`ERR: timeout`);
    }, EVAL_TIMEOUT_MS);
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); finish(`ERR: ${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) finish(`ERR: exit ${code} ${err.slice(0, 200)}`);
      else finish(out);
    });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {}
  });

  if (text.startsWith('ERR:')) {
    log.warn(`[auto-clear] eval ${topicLabel}: ${text}`);
    // On eval failure, be conservative: KEEP. The hard backstop still forces clear at 7d.
    return { clear: false, reason: `eval failed: ${text.slice(5, 100)}` };
  }

  // Extract first {...} block from output (claude sometimes wraps with prose).
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) {
    log.warn(`[auto-clear] eval ${topicLabel}: no JSON in output (${text.slice(0, 100)})`);
    return { clear: false, reason: 'eval produced no JSON' };
  }
  try {
    const parsed = JSON.parse(m[0]) as Partial<EvalResult>;
    return {
      clear: Boolean(parsed.clear),
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
    };
  } catch (e: any) {
    log.warn(`[auto-clear] eval ${topicLabel}: bad JSON (${e.message})`);
    return { clear: false, reason: 'eval JSON parse failed' };
  }
}

/** Single sweep: find and clear stale sessions */
async function clearStaleSessions(botApi: BotApi | null): Promise<void> {
  const now = Date.now();
  const sessions = listSessions();

  for (const session of sessions) {
    const id = Number(session.topicId);

    // Skip empty sessions, incognito (has its own TTL), and active processes
    if (session.messageCount === 0) continue;
    if (id === 0) continue;
    if (isActive(id)) continue;

    const idleMs = now - session.lastUsedAt;
    if (idleMs < AUTO_CLEAR_EVAL_MIN_MS) continue; // too fresh to even consider

    const name = topicName(id);
    const idleHours = Math.round(idleMs / 3_600_000);

    // Hard backstop: force clear regardless of eval verdict.
    let decision: EvalResult;
    if (idleMs >= AUTO_CLEAR_HARD_BACKSTOP_MS) {
      decision = { clear: true, reason: `hard backstop (>${Math.round(AUTO_CLEAR_HARD_BACKSTOP_MS / 86_400_000)}d idle)` };
      keepCache.delete(id);
    } else {
      // Cached "keep" verdict?
      const cached = keepCache.get(id);
      if (cached && cached.until > now) {
        log.info(`[auto-clear] ${name} skipped (kept by recent eval: ${cached.reason})`);
        continue;
      }

      const transcript = readTranscriptTail(session.sessionId, resolveTopicTarget(id).workDir, 30);
      if (!transcript) {
        log.info(`[auto-clear] ${name} no transcript — skipping eval (will retry next sweep)`);
        continue;
      }

      log.info(`[auto-clear] ${name} idle ${idleHours}h — evaluating...`);
      decision = await evaluateSessionState(name, idleHours, transcript);
      log.info(`[auto-clear] ${name} verdict: ${decision.clear ? 'CLEAR' : 'KEEP'} (${decision.reason})`);

      if (!decision.clear) {
        keepCache.set(id, { until: now + AUTO_CLEAR_KEEP_TTL_MS, reason: decision.reason });
        continue;
      }
      keepCache.delete(id);
    }

    log.info(`[auto-clear] ${name} clearing (${decision.reason})`);
    try {
      await summarizeAndSave(id, name);
      reset(id);
      log.info(`[auto-clear] ${name} cleared`);

      if (botApi) {
        const { chatId, threadId } = resolveTopicTarget(id);
        const note = `🧹 Auto-cleared <b>${name}</b> after ${idleHours}h idle.\n<i>${escapeHtml(decision.reason)}</i>`;
        try {
          await botApi.sendMessage(chatId, note, {
            parse_mode: 'HTML',
            disable_notification: true,
            ...(threadId ? { message_thread_id: threadId } : {}),
          } as any);
        } catch (e: any) {
          log.warn(`[auto-clear] failed to post notice for ${name}: ${e.message}`);
        }
      }
    } catch (e: any) {
      log.error(`[auto-clear] Failed to clear ${name}: ${e.message}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Start the auto-clear interval. Call once at boot. */
export function startAutoClear(botApi: BotApi | null = null): void {
  log.info(
    `[auto-clear] Enabled — eval-min ${AUTO_CLEAR_EVAL_MIN_MS / 3_600_000}h, ` +
    `keep-ttl ${AUTO_CLEAR_KEEP_TTL_MS / 3_600_000}h, ` +
    `backstop ${AUTO_CLEAR_HARD_BACKSTOP_MS / 86_400_000}d, ` +
    `model=${AUTO_CLEAR_EVAL_MODEL}, sweep every ${AUTO_CLEAR_INTERVAL_MS / 3_600_000}h`,
  );
  setInterval(() => {
    clearStaleSessions(botApi).catch(e => log.error('[auto-clear] Sweep error:', e.message));
  }, AUTO_CLEAR_INTERVAL_MS);
}
