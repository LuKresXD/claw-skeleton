import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { WORKSPACE } from '../config.js';
import { log } from '../util/logger.js';

/**
 * Cross-topic live feed. Every completed turn in the owner's DM topics writes a
 * single JSONL entry capturing {ts, topic, user_text, claw_text}. prompt-builder
 * reads the tail of this file and injects a `[Live]` line per message so other
 * topics see what's currently happening in real time — without depending on
 * daily-note writes (which are bursty / discretionary).
 *
 * Skipped for: groups (own history file), Guest (isolated workspace), incognito
 * (ephemeral by design), and turns with no useful text.
 */

const FEED_PATH = resolve(WORKSPACE, 'state/context/live-feed.jsonl');
const MAX_TEXT_CHARS = 220;            // truncation per side (user, claw)
const MAX_ENTRIES = 500;               // rolling cap
const ROTATE_THRESHOLD = MAX_ENTRIES * 1.5;

function squish(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string): string {
  const t = squish(s);
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS - 1) + '…' : t;
}

export function appendLiveFeed(entry: {
  topicId: number;
  topicName: string;
  userText: string;
  clawText: string;
}): void {
  if (!entry.topicId) return;
  const user = truncate(entry.userText || '');
  const claw = truncate(entry.clawText || '');
  if (!user && !claw) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    topic_id: entry.topicId,
    topic: entry.topicName,
    user,
    claw,
  }) + '\n';

  try {
    mkdirSync(dirname(FEED_PATH), { recursive: true });
    appendFileSync(FEED_PATH, line);
    maybeRotate();
  } catch (err) {
    log.warn(`live-feed append failed: ${(err as Error).message}`);
  }
}

function maybeRotate(): void {
  try {
    const lines = readFileSync(FEED_PATH, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > ROTATE_THRESHOLD) {
      const trimmed = lines.slice(-MAX_ENTRIES).join('\n') + '\n';
      writeFileSync(FEED_PATH, trimmed);
    }
  } catch (e) {
    log.debug(`live-feed rotate failed: ${(e as Error).message}`);
  }
}
