import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOT_DIR } from '../config.js';

interface ActiveEntry {
  topicId: number;
  topicName: string;
  chatId: string;
  threadId: number | null;
  startedAt: number;
  lastPrompt: string; // truncated original user message for resume context
}

const ACTIVE_FILE = resolve(BOT_DIR, 'active-topics.json');

function load(): Record<string, ActiveEntry> {
  try {
    return JSON.parse(readFileSync(ACTIVE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function save(data: Record<string, ActiveEntry>): void {
  writeFileSync(ACTIVE_FILE, JSON.stringify(data, null, 2));
}

/** Mark a topic as having an active Claude process */
export function trackActive(topicId: number, topicName: string, chatId: string, threadId: number | null, lastPrompt?: string): void {
  const data = load();
  data[String(topicId)] = {
    topicId, topicName, chatId, threadId,
    startedAt: Date.now(),
    lastPrompt: (lastPrompt || '').slice(0, 500), // truncate to keep file small
  };
  save(data);
}

/** Remove a topic from active tracking (process finished) */
export function untrackActive(topicId: number): void {
  const data = load();
  delete data[String(topicId)];
  save(data);
}

/** Check if a topic currently has an active Claude process */
export function isActive(topicId: number): boolean {
  const data = load();
  return String(topicId) in data;
}

/** Get topics that were interrupted (still in file after restart) and clear them */
export function getInterrupted(): ActiveEntry[] {
  const data = load();
  const entries = Object.values(data);
  if (entries.length > 0) {
    save({}); // Clear after reading
  }
  return entries;
}
