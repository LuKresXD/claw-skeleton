import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOT_DIR } from '../config.js';

const HISTORY_DIR = resolve(BOT_DIR, 'group-history');

interface HistoryEntry {
  ts: number;
  userId: number;
  userName: string;
  text: string;
}

function historyPath(chatId: string): string {
  return resolve(HISTORY_DIR, `${chatId}.jsonl`);
}

/** Append a message to the group's history file */
export function logMessage(chatId: string, userId: number, userName: string, text: string): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });

  const entry: HistoryEntry = { ts: Date.now(), userId, userName, text };
  appendFileSync(historyPath(chatId), JSON.stringify(entry) + '\n');
}

/**
 * Dynamic history window:
 * - Everything since the bot's last response (userId 0)
 * - Plus up to `buffer` messages before that
 * - Hard cap at `maxTotal` to avoid blowing up the prompt
 */
export function getRecentHistory(chatId: string, buffer = 50, maxTotal = 500): string {
  const path = historyPath(chatId);
  if (!existsSync(path)) return '';

  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
  if (!lines.length) return '';

  // Find the last bot response (userId 0 = Claw)
  let lastBotIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: HistoryEntry = JSON.parse(lines[i]);
      if (e.userId === 0) { lastBotIdx = i; break; }
    } catch {}
  }

  // Start index: `buffer` messages before last bot response, or just last `buffer` if no bot msg
  let startIdx: number;
  if (lastBotIdx >= 0) {
    startIdx = Math.max(0, lastBotIdx - buffer);
  } else {
    startIdx = Math.max(0, lines.length - buffer);
  }

  // Hard cap
  startIdx = Math.max(startIdx, lines.length - maxTotal);

  const selected = lines.slice(startIdx);

  return selected.map((line) => {
    try {
      const e: HistoryEntry = JSON.parse(line);
      const time = new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `[${time}] ${e.userName}: ${e.text}`;
    } catch {
      return '';
    }
  }).filter(Boolean).join('\n');
}
