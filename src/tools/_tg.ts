// Shared helper for the CLI toolbelt: a tiny typed wrapper around the Telegram Bot API.
//
// Each tool in src/tools/ is a standalone process the assistant shells out to from a turn
// (see CLAUDE.md → "The CLI Toolbelt"). They read BOT_TOKEN / CHAT_ID from the bot's .env,
// so they work whether the bot process is running or not. This file keeps the HTTP plumbing
// in one place; we use node:https (always typed via @types/node) rather than global fetch.
import 'dotenv/config';
import { request } from 'node:https';

const BOT_TOKEN = process.env.BOT_TOKEN || '';
export const DEFAULT_CHAT = process.env.CHAT_ID || '';

if (!BOT_TOKEN) {
  console.error('claw-tools: BOT_TOKEN is not set (check your .env)');
  process.exit(1);
}

/** Call a Telegram Bot API method with JSON params. Resolves with `result`, throws on `ok:false`. */
export function tgCall<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
  const body = JSON.stringify(params);
  return new Promise<T>((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) resolve(parsed.result as T);
            else reject(new Error(`${method}: ${parsed.description || 'unknown error'}`));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** The default thread (forum sub-topic) for a turn, if the runner injected one. '' = General/DM. */
export function envThread(): number | undefined {
  const t = process.env.CLAW_THREAD_ID;
  return t ? Number(t) : undefined;
}

/**
 * A stable key for "this turn", so a per-turn artifact (e.g. the progress line) can't be
 * confused with another turn's. The runner injects CLAW_MESSAGE_ID = the triggering message id.
 */
export function turnKey(chat: string, thread: number | undefined): string {
  const trigger = process.env.CLAW_MESSAGE_ID || 'adhoc';
  return `${chat}_${thread ?? 0}_${trigger}`;
}
