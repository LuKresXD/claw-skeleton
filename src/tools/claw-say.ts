#!/usr/bin/env node
// claw-say — post or edit a Telegram message from inside a turn.
//
//   claw-say "hello"                  # send a message to the default chat
//   claw-say --edit 123 "updated"     # edit message 123
//   claw-say --thread 42 "in topic"   # send into forum sub-topic 42
//   claw-say --progress "⏳ 40% · …"   # ONE self-updating status line for this turn
//
// --progress is the important one: it manages a single line per turn (keyed by the turn's
// trigger message), sending it on the first call and editing it in place after — so a long
// task shows live progress without spamming the chat, and it can never clobber an earlier
// turn's line. See CLAUDE.md → "Progress on Long Tasks". This is a sanitized example of the
// pattern; the production tool adds retries, truncation, and richer routing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tgCall, DEFAULT_CHAT, envThread, turnKey } from './_tg.js';

interface Args { text: string; edit?: number; thread?: number; chat: string; progress: boolean; silent: boolean; }

function parseArgs(argv: string[]): Args {
  const a: Args = { text: '', chat: DEFAULT_CHAT, progress: false, silent: false, thread: envThread() };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--edit') a.edit = Number(argv[++i]);
    else if (v === '--thread') a.thread = Number(argv[++i]);
    else if (v === '--chat') a.chat = argv[++i];
    else if (v === '--progress') a.progress = true;
    else if (v === '--silent') a.silent = true;
    else rest.push(v);
  }
  a.text = rest.join(' ');
  return a;
}

const PROGRESS_DIR = join(tmpdir(), 'claw-progress');

function send(a: Args) {
  return tgCall<{ message_id: number }>('sendMessage', {
    chat_id: a.chat,
    text: a.text,
    ...(a.thread ? { message_thread_id: a.thread } : {}),
    ...(a.progress || a.silent ? { disable_notification: true } : {}),
  });
}

function edit(a: Args, messageId: number) {
  return tgCall<{ message_id: number }>('editMessageText', {
    chat_id: a.chat,
    message_id: messageId,
    text: a.text,
  });
}

async function run() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.text) { console.error('claw-say: nothing to say'); process.exit(1); }

  // --progress: one tracked line per turn. First call sends + records the id; later calls edit it.
  if (a.progress) {
    mkdirSync(PROGRESS_DIR, { recursive: true });
    const file = join(PROGRESS_DIR, turnKey(a.chat, a.thread));
    let tracked: number | undefined;
    try { tracked = Number(readFileSync(file, 'utf-8').trim()) || undefined; } catch { /* first call */ }
    if (tracked) {
      try {
        const r = await edit(a, tracked);
        return console.log(JSON.stringify({ message_id: r.message_id, edited: true }));
      } catch { /* original line gone — fall through to a fresh send */ }
    }
    const r = await send(a);
    writeFileSync(file, String(r.message_id));
    return console.log(JSON.stringify({ message_id: r.message_id, edited: false }));
  }

  const r = a.edit ? await edit(a, a.edit) : await send(a);
  console.log(JSON.stringify({ message_id: r.message_id, edited: Boolean(a.edit) }));
}

run().catch((e) => { console.error(`claw-say: ${e.message}`); process.exit(1); });
