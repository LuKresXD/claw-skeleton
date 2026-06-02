import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Bot, NextFunction } from 'grammy';
import { OWNER_USER_ID, TOPICS, type TopicConfig } from '../config.js';
import { buildSystemPrompt, buildUserPrompt } from '../claude/prompt-builder.js';
import { mdToHtml } from '../telegram/sender.js';
import { log } from '../util/logger.js';
import type { MyContext } from '../index.js';

/**
 * Telegram Bot API 5.0 Guest Mode handler.
 *
 * When @YourBot is mentioned in a chat where the bot is NOT a member,
 * Telegram delivers an Update with a `guest_message` field. The bot has ONE
 * chance to reply via the `answerGuestQuery` HTTP method.
 *
 * grammY 1.35.0 does not yet know about guest_message / answerGuestQuery, so:
 *   - We sniff `(ctx.update as any).guest_message` in a raw middleware.
 *   - We POST to `https://api.telegram.org/bot<token>/answerGuestQuery` directly.
 *
 * Spec: https://core.telegram.org/bots/features#guest-bots
 *       https://core.telegram.org/bots/api#answerguestquery
 */

const CLAUDE_BIN = '/root/.local/bin/claude';
const CLAUDE_TIMEOUT_MS = 50_000;
const MAX_REPLY_CHARS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const BOT_MENTION_RE = /@YourBot/gi;

interface GuestMessage {
  guest_query_id: string;
  guest_bot_caller_user?: { id: number; first_name?: string; username?: string };
  guest_bot_caller_chat?: { id: number; type?: string };
  message_thread_id?: number;
  from?: { id: number };
  text?: string;
  caption?: string;
  reply_to_message?: { text?: string; caption?: string };
}

interface CacheEntry {
  text: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

interface PersonaMatch {
  /** Synthetic topic config for the chosen persona, used by buildSystemPrompt/buildUserPrompt. */
  topicConfig: TopicConfig;
  /** Synthetic topic id (the matched topic's real id, used in [Topic: ...] header). */
  topicId: number;
  cleanQuery: string;
}

// Topic IDs we mirror into guest mode (must match TOPICS keys in config.ts).
const TOPIC_GENERAL = 1000001;
const TOPIC_CODING  = 1000002;
const TOPIC_COACH   = 1000003;

function detectPersona(text: string): PersonaMatch {
  const trimmed = text.replace(/^\s+/, '');
  const m = trimmed.match(/^(coach|coding|tasks)\s*:\s*([\s\S]*)$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const rest = m[2];
    if (name === 'coach')  return { topicConfig: { ...TOPICS[TOPIC_COACH],  name: 'Guest (Coach)' },  topicId: TOPIC_COACH,  cleanQuery: rest };
    if (name === 'coding') return { topicConfig: { ...TOPICS[TOPIC_CODING], name: 'Guest (Coding)' }, topicId: TOPIC_CODING, cleanQuery: rest };
    // 'tasks' maps to general (no dedicated tasks persona).
    return { topicConfig: { ...TOPICS[TOPIC_GENERAL], name: 'Guest (Tasks)' }, topicId: TOPIC_GENERAL, cleanQuery: rest };
  }
  return { topicConfig: { ...TOPICS[TOPIC_GENERAL], name: 'Guest (General)' }, topicId: TOPIC_GENERAL, cleanQuery: trimmed };
}

function stripMention(text: string): string {
  return text.replace(BOT_MENTION_RE, '').replace(/\s+/g, ' ').trim();
}

function cacheKey(persona: string, query: string, replyContext: string, scope: string): string {
  const h = createHash('sha256');
  h.update(persona);
  h.update('|');
  h.update(query);
  h.update('|');
  h.update(replyContext);
  // Scope by originating chat (+thread when present) so the same question asked
  // in two different chats never returns a cross-pollinated cached answer.
  h.update('|');
  h.update(scope);
  return h.digest('hex').slice(0, 16);
}

interface ClaudeResult {
  text: string;
  error: string | null;
}

const GUEST_MODE_DIRECTIVE = [
  '## Guest Mode',
  'You are responding to an ephemeral guest mention via Telegram Bot API guest mode.',
  '- ONE-SHOT reply only. No follow-ups, no continuity. Don\'t ask clarifying questions — take best-effort action.',
  '- FULL tool access is enabled (Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, etc.). Use them when the request actually requires it (e.g. "add this meeting to my calendar" → gog calendar create; "log a meal" → mfp-log.py). Otherwise reason from injected context.',
  '- DO NOT write to memory files for guest queries (MEMORY.md, state/memory/YYYY-MM-DD.md, topic-*.md, vault digests). Guest mode is ephemeral — don\'t pollute the second brain with one-off queries.',
  '- Keep replies under ~600 characters when possible. Markdown -> Telegram HTML conversion happens automatically.',
  '- VISIBILITY: your reply posts INTO whatever chat the owner mentioned you in, visible to everyone there. If the owner didn\'t explicitly ask for it, do NOT surface sensitive context (health, finances, grades, private relationship details, anything personal). Answer narrowly to what was asked; only reveal the owner-private context if the question directly requires it.',
].join('\n');

async function runClaudeOneShot(topicConfig: TopicConfig, topicId: number, userQuery: string): Promise<ClaudeResult> {
  const systemPrompt = buildSystemPrompt(topicConfig) + '\n\n' + GUEST_MODE_DIRECTIVE;
  const userPrompt = buildUserPrompt(topicConfig, topicId, userQuery, [], false, 0);

  const args = [
    '-p',
    '--model', 'sonnet',
    '--effort', 'low',
    '--no-session-persistence',
    '--output-format', 'text',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', systemPrompt,
    userPrompt,
  ];

  return new Promise<ClaudeResult>((resolveP) => {
    let settled = false;
    const finish = (r: ClaudeResult) => {
      if (settled) return;
      settled = true;
      resolveP(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CLAUDE_BIN, args, {
        env: { ...process.env, HOME: '/root', IS_SANDBOX: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e: any) {
      finish({ text: '', error: `spawn failed: ${e.message}` });
      return;
    }

    let out = '';
    let err = '';

    const timer = setTimeout(() => {
      log.warn('[Guest] Claude timeout — killing process');
      try { child.kill('SIGTERM'); } catch {}
      finish({ text: '', error: `Claude timed out (${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s)` });
    }, CLAUDE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString(); });

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ text: '', error: `spawn error: ${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code !== 0 && !text) {
        finish({ text: '', error: `claude exit ${code}: ${err.slice(0, 200)}` });
        return;
      }
      finish({ text, error: null });
    });

    // Close stdin — no piped prompt
    try { child.stdin?.end(); } catch {}
  });
}

/**
 * POST to Telegram's answerGuestQuery endpoint.
 *
 * Per https://core.telegram.org/bots/api#answerguestquery the payload is:
 *   { guest_query_id, result: InlineQueryResult }
 * The result type is REUSED from inline-mode results. For a text reply we
 * wrap in InlineQueryResultArticle with InputTextMessageContent.
 *
 * Falls back to plain text (no parse_mode) if HTML is rejected.
 */
async function sendGuestAnswer(guestQueryId: string, text: string, useHtml: boolean): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    log.error('[Guest] BOT_TOKEN missing');
    return;
  }
  const url = `https://api.telegram.org/bot${token}/answerGuestQuery`;

  const inputContent: Record<string, unknown> = { message_text: text };
  if (useHtml) inputContent.parse_mode = 'HTML';

  const body = {
    guest_query_id: guestQueryId,
    result: {
      type: 'article',
      id: guestQueryId.slice(0, 32),
      title: 'Claw',
      input_message_content: inputContent,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn(`[Guest] answerGuestQuery ${res.status}: ${errText.slice(0, 200)}`);
      if (useHtml && res.status === 400) {
        log.info('[Guest] Retrying without parse_mode');
        await sendGuestAnswer(guestQueryId, text.replace(/<[^>]+>/g, ''), false);
      }
    }
  } catch (e: any) {
    log.error(`[Guest] answerGuestQuery fetch failed: ${e.message}`);
  }
}

function pickText(gm: GuestMessage): string {
  return (gm.text || gm.caption || '').toString();
}

function pickReplyContext(gm: GuestMessage): string {
  const r = gm.reply_to_message;
  if (!r) return '';
  return (r.text || r.caption || '').toString();
}

/**
 * Middleware: intercept guest_message updates and answer them directly.
 * MUST be installed before authMiddleware (auth rejects non-the owner users).
 */
export function registerGuestHandler(bot: Bot<MyContext>): void {
  bot.use(async (ctx, next: NextFunction) => {
    const gm = (ctx.update as any)?.guest_message as GuestMessage | undefined;
    if (!gm || !gm.guest_query_id) {
      return next();
    }

    const guestQueryId = gm.guest_query_id;
    const callerId = gm.guest_bot_caller_user?.id ?? gm.from?.id ?? 0;
    const callerChat = gm.guest_bot_caller_chat?.id ?? 'unknown';

    log.info(`[Guest] query=${guestQueryId.slice(0, 12)} caller=${callerId} chat=${callerChat}`);

    // 1. Access filter: the owner only
    if (callerId !== OWNER_USER_ID) {
      log.warn(`[Guest] Rejected non-the owner caller: ${callerId} (chat ${callerChat})`);
      await sendGuestAnswer(guestQueryId, '⛔ Claw is in private mode.', false);
      return;
    }

    const rawText = pickText(gm);
    if (!rawText) {
      log.info('[Guest] Empty text after pickText');
      await sendGuestAnswer(guestQueryId, 'No query?', false);
      return;
    }

    // 2. Persona detection + 3. mention stripping
    const { topicConfig, topicId, cleanQuery: prefixStripped } = detectPersona(rawText);
    const cleanQuery = stripMention(prefixStripped);

    if (!cleanQuery) {
      log.info('[Guest] Empty cleanQuery after stripping');
      await sendGuestAnswer(guestQueryId, 'No query?', false);
      return;
    }

    const replyContext = pickReplyContext(gm);

    // 4. Cache lookup — scoped to the originating chat (+thread when present) so
    // the same question from two different chats can't cross-pollinate answers.
    const scope = `${callerChat}:${gm.message_thread_id ?? ''}`;
    const key = cacheKey(topicConfig.persona, cleanQuery, replyContext, scope);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      log.info(`[Guest] Cache hit key=${key}`);
      await sendGuestAnswer(guestQueryId, cached.text, true);
      return;
    }

    // 5. Build the user query (prepend replied-to context if the owner was replying)
    const userQuery = replyContext
      ? `Context (message I'm replying to):\n${replyContext}\n\n---\n\nMy question:\n${cleanQuery}`
      : cleanQuery;

    log.info(`[Guest] Running claude persona=${topicConfig.persona} topic=${topicConfig.name} len=${cleanQuery.length}`);

    let result: ClaudeResult;
    try {
      result = await runClaudeOneShot(topicConfig, topicId, userQuery);
    } catch (e: any) {
      log.error(`[Guest] Unexpected runClaudeOneShot throw: ${e.message}`);
      result = { text: '', error: e.message };
    }

    if (result.error || !result.text) {
      const msg = result.error || 'Empty response';
      log.warn(`[Guest] Claude failed: ${msg}`);
      await sendGuestAnswer(guestQueryId, `⚠️ ${msg.slice(0, 200)}`, false);
      return;
    }

    // 6. Convert and cap
    let html: string;
    try {
      html = mdToHtml(result.text);
    } catch (e: any) {
      log.warn(`[Guest] mdToHtml failed: ${e.message}; falling back to plain`);
      html = result.text;
    }
    if (html.length > MAX_REPLY_CHARS) {
      html = html.slice(0, MAX_REPLY_CHARS - 3) + '...';
    }

    // 7. Cache (only successful, non-empty responses)
    cache.set(key, { text: html, expiresAt: Date.now() + CACHE_TTL_MS });

    // 8. Send
    await sendGuestAnswer(guestQueryId, html, true);
    log.info(`[Guest] Answered query=${guestQueryId.slice(0, 12)} chars=${html.length}`);
    // Do NOT call next() — guest updates don't flow into regular routing.
  });
}
