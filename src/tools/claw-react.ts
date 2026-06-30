#!/usr/bin/env node
// claw-react — set or clear an emoji reaction on a Telegram message.
//
//   claw-react 123 🔥        # react to message 123 with 🔥
//   claw-react 123 --remove  # clear reactions from message 123
//   claw-react 123 🎉 --big  # play the big animated reaction effect
//
// Reactions are a low-friction way for the assistant to acknowledge a message without sending
// a whole reply (see CLAUDE.md → "Emoji & Reactions"). Only Telegram's standard reaction set is
// valid; an unsupported emoji is rejected by the API. Sanitized example.
import { tgCall, DEFAULT_CHAT } from './_tg.js';

function run() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((v) => v.startsWith('--')));
  const pos = argv.filter((v) => !v.startsWith('--'));
  const messageId = Number(pos[0]);
  const emoji = pos[1];

  if (!messageId || (!emoji && !flags.has('--remove'))) {
    console.error('usage: claw-react <message_id> <emoji> [--big] | claw-react <message_id> --remove');
    process.exit(1);
  }

  const reaction = flags.has('--remove') ? [] : [{ type: 'emoji', emoji }];
  return tgCall('setMessageReaction', {
    chat_id: DEFAULT_CHAT,
    message_id: messageId,
    reaction,
    is_big: flags.has('--big'),
  });
}

Promise.resolve(run())
  .then(() => console.log(JSON.stringify({ ok: true })))
  .catch((e) => { console.error(`claw-react: ${e.message}`); process.exit(1); });
