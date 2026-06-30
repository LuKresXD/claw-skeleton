import type { Bot, Context } from 'grammy';
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/logger.js';
import type { MyContext } from '../index.js';
import { WORKSPACE } from '../config.js';

/**
 * Callback-query handler for claw-ask inline keyboards.
 *
 * Flow:
 *   1. claw-ask CLI sends a Telegram message with inline_keyboard, writes a pending
 *      state file at state/claw-ask/<askId>.json, and polls the file for an answer.
 *   2. the owner taps a button → this handler fires with callback_data = `aq:<askId>:<action>[:<idx>]`.
 *   3. We mutate the pending file (toggle selection or commit final answer).
 *   4. The CLI sees `answer` set on its next poll and exits, returning the choice
 *      to the Claude session that invoked it.
 *
 * callback_data formats (kept short; 64-byte Telegram cap):
 *   aq:<askId>:p:<i>     single-select pick (index i)
 *   aq:<askId>:t:<i>     multi-select toggle (index i)
 *   aq:<askId>:done      multi-select commit
 *   aq:<askId>:cancel    user cancels
 */

const STATE_DIR = join(WORKSPACE, 'state/claw-ask');

interface PendingAsk {
  askId: string;
  chatId: string;
  threadId: number | null;
  messageId: number;
  question: string;
  header: string | null;
  options: string[];
  descriptions: string[];
  multi: boolean;
  selected: number[];
  answer: string | string[] | null;
  answerIndices: number | number[] | null;
  cancelled: boolean;
  timedOut: boolean;
  createdAt: number;
  expiresAt: number;
}

function loadAsk(askId: string): PendingAsk | null {
  const path = join(STATE_DIR, `${askId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function saveAsk(ask: PendingAsk): void {
  const path = join(STATE_DIR, `${ask.askId}.json`);
  // Write to a temp file then rename over the target so the polling CLI never
  // reads a half-written/truncated JSON. Mode 0600 — these files can carry the
  // question/answer text and are owned by the bot only.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ask, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildBodyText(ask: PendingAsk): string {
  let text = '';
  if (ask.header) text += `<i>[${escapeHtml(ask.header)}]</i>\n`;
  text += `<b>${escapeHtml(ask.question)}</b>\n`;
  if (ask.descriptions.length === ask.options.length) {
    text += '\n';
    for (let i = 0; i < ask.options.length; i++) {
      text += `<b>${escapeHtml(ask.options[i])}</b> — ${escapeHtml(ask.descriptions[i])}\n`;
    }
  }
  return text.trim();
}

function buildKeyboard(ask: PendingAsk) {
  const selectedSet = new Set(ask.selected);
  const rows = ask.options.map((opt, i) => {
    const prefix = ask.multi ? (selectedSet.has(i) ? '✅ ' : '⬜ ') : '';
    const tag = ask.multi ? 't' : 'p';
    return [{ text: `${prefix}${opt}`, callback_data: `aq:${ask.askId}:${tag}:${i}` }];
  });
  if (ask.multi) {
    rows.push([
      { text: '✓ Done', callback_data: `aq:${ask.askId}:done` },
      { text: '✗ Cancel', callback_data: `aq:${ask.askId}:cancel` },
    ]);
  } else {
    rows.push([{ text: '✗ Cancel', callback_data: `aq:${ask.askId}:cancel` }]);
  }
  return { inline_keyboard: rows };
}

/**
 * Register callback_query handler on the bot. Handles claw-ask data only;
 * anything else is ignored so other callback handlers can be added later.
 */
export function registerCallbackHandlers(bot: Bot<MyContext>): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('aq:')) return; // not ours

    const parts = data.split(':');
    // parts: ["aq", askId, action, optIdx?]
    const askId = parts[1];
    const action = parts[2];
    const optIdx = parts[3] !== undefined ? parseInt(parts[3], 10) : -1;

    const ask = loadAsk(askId);
    if (!ask) {
      await ctx.answerCallbackQuery({ text: 'Question expired or unknown.' }).catch(() => {});
      return;
    }
    if (ask.answer !== null || ask.cancelled || ask.timedOut) {
      await ctx.answerCallbackQuery({ text: 'Already answered.' }).catch(() => {});
      return;
    }
    if (Date.now() > ask.expiresAt) {
      ask.timedOut = true;
      saveAsk(ask);
      await ctx.answerCallbackQuery({ text: 'Timed out.' }).catch(() => {});
      return;
    }

    if (action === 'cancel') {
      ask.cancelled = true;
      saveAsk(ask);
      try {
        await ctx.api.editMessageText(
          ask.chatId,
          ask.messageId,
          buildBodyText(ask) + '\n\n<i>(cancelled)</i>',
          { parse_mode: 'HTML' },
        );
      } catch {}
      await ctx.answerCallbackQuery({ text: 'Cancelled.' }).catch(() => {});
      return;
    }

    if (action === 'p') {
      // Single-select pick: commit immediately
      if (optIdx < 0 || optIdx >= ask.options.length) {
        await ctx.answerCallbackQuery({ text: 'Bad index.' }).catch(() => {});
        return;
      }
      ask.answer = ask.options[optIdx];
      ask.answerIndices = optIdx;
      saveAsk(ask);
      try {
        await ctx.api.editMessageText(
          ask.chatId,
          ask.messageId,
          buildBodyText(ask) + `\n\n<b>→ ${escapeHtml(ask.options[optIdx])}</b>`,
          { parse_mode: 'HTML' },
        );
      } catch {}
      await ctx.answerCallbackQuery({ text: `Picked: ${ask.options[optIdx]}` }).catch(() => {});
      return;
    }

    if (action === 't') {
      // Multi-select toggle: flip in selected[]
      if (!ask.multi) {
        await ctx.answerCallbackQuery({ text: 'Not multi-select.' }).catch(() => {});
        return;
      }
      if (optIdx < 0 || optIdx >= ask.options.length) {
        await ctx.answerCallbackQuery({ text: 'Bad index.' }).catch(() => {});
        return;
      }
      const idx = ask.selected.indexOf(optIdx);
      if (idx >= 0) ask.selected.splice(idx, 1);
      else ask.selected.push(optIdx);
      ask.selected.sort((a, b) => a - b);
      saveAsk(ask);
      try {
        await ctx.api.editMessageReplyMarkup(ask.chatId, ask.messageId, {
          reply_markup: buildKeyboard(ask),
        });
      } catch {}
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }

    if (action === 'done') {
      if (!ask.multi) {
        await ctx.answerCallbackQuery({ text: 'Not multi-select.' }).catch(() => {});
        return;
      }
      const picks = ask.selected.map(i => ask.options[i]);
      ask.answer = picks;
      ask.answerIndices = [...ask.selected];
      saveAsk(ask);
      const picksLabel = picks.length ? picks.join(', ') : '(none)';
      try {
        await ctx.api.editMessageText(
          ask.chatId,
          ask.messageId,
          buildBodyText(ask) + `\n\n<b>→ ${escapeHtml(picksLabel)}</b>`,
          { parse_mode: 'HTML' },
        );
      } catch {}
      await ctx.answerCallbackQuery({ text: `Picked: ${picksLabel}` }).catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Unknown action.' }).catch(() => {});
  });
}

/**
 * Cancel any in-flight claw-ask for a (chatId, threadId) pair. Called by the
 * router when the owner sends a normal text message while a picker is open — typing
 * cancels the picker so the new message can be processed immediately instead of
 * queueing behind the blocked Claude turn that's polling claw-ask.
 *
 * Marks `cancelled: true` on every matching state file with `answer === null`.
 * The CLI poller sees the change on its next 250ms tick and exits with
 * `{cancelled: true}`, unblocking the Bash call and the Claude turn.
 *
 * Returns the number of pickers cancelled (for logging).
 */
export function cancelPendingAsks(chatId: string | number, threadId: number | null): number {
  if (!existsSync(STATE_DIR)) return 0;
  const targetChat = String(chatId);
  const now = Date.now();
  let cancelled = 0;
  for (const f of readdirSync(STATE_DIR)) {
    if (!f.endsWith('.json')) continue;
    const p = join(STATE_DIR, f);
    let ask: PendingAsk;
    try {
      ask = JSON.parse(readFileSync(p, 'utf8'));
    } catch { continue; }
    if (ask.chatId !== targetChat) continue;
    // Match thread: both null OR both equal
    const askThread = ask.threadId ?? null;
    const reqThread = threadId ?? null;
    if (askThread !== reqThread) continue;
    if (ask.answer !== null || ask.cancelled || ask.timedOut) continue;
    if (ask.expiresAt < now) continue;
    ask.cancelled = true;
    saveAsk(ask);
    cancelled++;
    log.info(`claw-ask cancel-on-text: askId=${ask.askId} chat=${targetChat} thread=${reqThread}`);
  }
  return cancelled;
}

/**
 * Sweep stale claw-ask state files. Runs hourly.
 * Drops files whose expiresAt is more than 1h in the past — keeps recent
 * completed asks around briefly in case the polling CLI hasn't read them yet.
 */
export function startClawAskSweeper(): void {
  setInterval(() => {
    try {
      if (!existsSync(STATE_DIR)) return;
      const cutoff = Date.now() - 60 * 60 * 1000;
      let removed = 0;
      for (const f of readdirSync(STATE_DIR)) {
        if (!f.endsWith('.json')) continue;
        const p = join(STATE_DIR, f);
        try {
          const ask = JSON.parse(readFileSync(p, 'utf8')) as PendingAsk;
          if (ask.expiresAt < cutoff || (ask.answer !== null && statSync(p).mtimeMs < cutoff)) {
            unlinkSync(p);
            removed++;
          }
        } catch {}
      }
      if (removed) log.info(`claw-ask sweeper: cleared ${removed} stale state file(s)`);
    } catch (err: any) {
      log.error('claw-ask sweeper error:', err.message);
    }
  }, 60 * 60 * 1000); // hourly
}
