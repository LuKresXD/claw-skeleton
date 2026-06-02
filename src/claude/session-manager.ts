import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BOT_DIR } from '../config.js';
import { log } from '../util/logger.js';

export interface SessionEntry {
  sessionId: string;
  model: string;
  effort: string;
  messageCount: number;
  createdAt: number;
  lastUsedAt: number;
  lastSummarizedAt?: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

type SessionStore = Record<string, SessionEntry>;

const SESSIONS_FILE = resolve(BOT_DIR, 'sessions.json');

let store: SessionStore = {};

export function loadSessions(): void {
  try {
    store = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    log.info(`Loaded ${Object.keys(store).length} sessions`);
  } catch {
    store = {};
    log.info('No existing sessions file, starting fresh');
  }
}

function save(): void {
  const tmp = SESSIONS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, SESSIONS_FILE);
}

export function getSession(topicId: number): SessionEntry | null {
  return store[String(topicId)] ?? null;
}

export function getOrCreate(topicId: number, defaultModel = 'sonnet'): SessionEntry {
  const key = String(topicId);
  if (store[key]) {
    return store[key];
  }

  const entry: SessionEntry = {
    sessionId: randomUUID(),
    model: defaultModel,
    effort: 'auto',
    messageCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
  store[key] = entry;
  save();
  log.info(`Created session for topic ${topicId}: ${entry.sessionId.slice(0, 8)}...`);
  return entry;
}

export function touch(topicId: number): void {
  const key = String(topicId);
  if (store[key]) {
    store[key].messageCount++;
    store[key].lastUsedAt = Date.now();
    save();
  }
}

export function reset(topicId: number): boolean {
  const key = String(topicId);
  if (store[key]) {
    const { model, effort, totalCostUsd, totalInputTokens, totalOutputTokens } = store[key];
    delete store[key];
    save();
    log.info(`Reset session for topic ${topicId}`);
    // Re-create with preserved model/effort and cumulative usage
    const entry = getOrCreate(topicId, model);
    entry.effort = effort;
    entry.totalCostUsd = totalCostUsd;
    entry.totalInputTokens = totalInputTokens;
    entry.totalOutputTokens = totalOutputTokens;
    save();
    return true;
  }
  return false;
}

export function setModel(topicId: number, model: string): void {
  const key = String(topicId);
  if (store[key]) {
    store[key].model = model;
    save();
  }
}

export function addUsage(topicId: number, costUsd: number, inputTokens: number, outputTokens: number): void {
  const key = String(topicId);
  if (store[key]) {
    store[key].totalCostUsd = (store[key].totalCostUsd || 0) + costUsd;
    store[key].totalInputTokens = (store[key].totalInputTokens || 0) + inputTokens;
    store[key].totalOutputTokens = (store[key].totalOutputTokens || 0) + outputTokens;
    save();
  }
}

export function setEffort(topicId: number, effort: string): void {
  const key = String(topicId);
  if (store[key]) {
    store[key].effort = effort;
    save();
  }
}

export function setLastSummarizedAt(topicId: number, timestamp: number): void {
  const key = String(topicId);
  if (store[key]) {
    store[key].lastSummarizedAt = timestamp;
    save();
  }
}

export function listSessions(): Array<{ topicId: string } & SessionEntry> {
  return Object.entries(store).map(([topicId, entry]) => ({ topicId, ...entry }));
}
