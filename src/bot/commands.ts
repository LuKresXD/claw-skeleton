import type { Context } from 'grammy';
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE, TOPICS, GUEST_TOPICS, GUEST_WORKSPACE, GUEST_USER_ID, GUEST_CHAT_ID, BOT_DIR, GROUP_CHATS, DAY_BOUNDARY_HOUR, OWNER_USER_ID, MAX_CONCURRENT, resolveModel } from '../config.js';
import { getQueueStats } from './middleware/queue.js';
import { getPendingGroupCount } from './middleware/mediaGroup.js';
import { reset, setModel, setEffort, getSession, getOrCreate, listSessions, setLastSummarizedAt } from '../claude/session-manager.js';
import { runClaude, stopTopic } from '../claude/runner.js';
import { ProgressiveEditor } from '../telegram/sender.js';
import { CHAT_ID } from '../config.js';
import { clearIncognito } from './incognito.js';
import { log } from '../util/logger.js';

/**
 * Get the daily-notes date for a UTC timestamp.
 * Timestamps before DAY_BOUNDARY_HOUR (CDT) belong to the previous day,
 * since the owner is often up until 3-4 AM.
 */
function getNotesDate(utcTimestamp: string): string {
  const shifted = new Date(new Date(utcTimestamp).getTime() - DAY_BOUNDARY_HOUR * 3600_000);
  return shifted.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * Claude stores transcripts under ~/.claude/projects/<slug>/ where slug is the
 * spawn cwd with `/` and `.` replaced by `-`. Must match that slugification
 * exactly or the lookup misses.
 */
function sessionDirForWorkDir(workDir: string): string {
  const slug = workDir.replace(/[/.]/g, '-');
  return resolve('/root/.claude/projects', slug);
}

/**
 * Extract conversation transcript split by daily-notes date.
 * Each date gets its own transcript budget (8000 chars).
 * If sinceMs is provided, only messages with timestamp > sinceMs are included.
 * Returns transcripts + maxTimestamp of any message processed.
 */
function extractTranscriptsByDate(sessionId: string, workDir: string, sinceMs: number = 0): { transcripts: Map<string, string>; maxTimestamp: number } {
  const sessionDir = sessionDirForWorkDir(workDir);
  const file = resolve(sessionDir, `${sessionId}.jsonl`);
  const byDate = new Map<string, string[]>();
  let maxTimestamp = sinceMs;

  try {
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    for (const line of lines) {
      const o = JSON.parse(line);
      const ts = o.timestamp;
      if (!ts) continue;

      const tsMs = new Date(ts).getTime();
      if (!Number.isFinite(tsMs)) continue;
      if (tsMs <= sinceMs) continue;
      if (tsMs > maxTimestamp) maxTimestamp = tsMs;

      let text = '';
      if (o.type === 'user') {
        const c = o.message?.content;
        text = typeof c === 'string' ? c : (c || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (text) text = `USER: ${text.slice(0, 300)}`;
      } else if (o.type === 'assistant') {
        const c = o.message?.content;
        text = (c || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        if (text) text = `CLAW: ${text.slice(0, 300)}`;
      }

      if (text) {
        const date = getNotesDate(ts);
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(text);
      }
    }
  } catch {
    return { transcripts: new Map<string, string>(), maxTimestamp: sinceMs };
  }

  const result = new Map<string, string>();
  for (const [date, msgs] of byDate) {
    let transcript = msgs.join('\n\n');
    if (transcript.length > 8000) transcript = '...\n\n' + transcript.slice(-8000);
    result.set(date, transcript);
  }
  return { transcripts: result, maxTimestamp };
}

/**
 * Compute daily-notes directory (relative to workDir).
 * the owner's WORKSPACE uses state/memory/; isolated workspaces (Guest, groups) use memory/.
 */
function getDailyNotesDir(workDir: string): string {
  return workDir === WORKSPACE ? 'state/memory' : 'memory';
}

/**
 * Slugify a topic name for the `topic:` frontmatter field.
 * "Settings" → "settings", "Guest Health" → "guest-health", "Friends Group" → "group-friends".
 */
function slugifyTopic(name: string, chatType: 'private' | 'group'): string {
  let slug = name.toLowerCase().replace(/\s+/g, '-');
  if (chatType === 'group') {
    slug = slug.replace(/-group$/, '');
    if (!slug.startsWith('group-')) slug = `group-${slug}`;
  }
  return slug;
}

/**
 * Spawn a summarizer for one date's transcript.
 * Emits YAML-block entries per SESSION_PROTOCOL.md into the daily note.
 * Does NOT touch MEMORY.md or topic-*.md — that's the nightly rollup's job.
 */
async function runDateSummarizer(
  date: string, transcript: string,
  topicName: string, topicSlug: string,
  chatType: 'private' | 'group', chatId: string,
  sessionIdShort: string,
  workDir: string, dailyNotesDir: string,
): Promise<boolean> {
  const dailyNotesPath = resolve(workDir, dailyNotesDir, `${date}.md`);
  const isOwnerWorkspace = workDir === WORKSPACE;
  const decisionsDir = resolve(workDir, 'obsidian-vault/Claw/Decisions');

  const prompt = `SESSION ENDING for topic "${topicName}". Transcript from ${date}:

<transcript>
${transcript}
</transcript>

Step 1 — Append YAML-block entries to ${dailyNotesPath} for anything worth remembering.

Format per entry (YAML frontmatter + markdown body + trailing separator):

---
id: ${date}T[HH-MM-SS]-[3-random-chars]
session_id: ${sessionIdShort}
topic: ${topicSlug}
chat_type: ${chatType}
chat_id: ${chatId}
timestamp: ${date}T[HH:MM:SS]-05:00
importance: <1-5>
tags: [tag1, tag2]
summarized_at: null
---

<1-3 sentence markdown body in English>

---

Daily-note rules:
- Bar is LOW: log decisions, preferences, facts, deadlines, important emails, anything future-you might ask "did we talk about X?".
- Skip: greetings, routing, trivial acks, content already captured in the file.
- Importance: 1=trivia, 3=worth remembering, 5=load-bearing.
- Keep bodies short (1-3 sentences). Multiple entries fine — one per logical event.
- summarized_at MUST be null — nightly rollup stamps it.
- Always English; the owner quotes can stay in original language.
- File may already exist — APPEND new entries (never overwrite existing ones or touch entries with summarized_at set).

${isOwnerWorkspace ? `Step 2 — Decisions/ backstop (the owner's workspace only).

Scan the transcript for non-trivial decisions: architectural / infra choices, project plans, tool selections, financial moves, internship / equity / housing / course-planning calls. If you find one or more, ALSO create ${decisionsDir}/<kebab-case-name>.md per entry. Glance at existing files in that dir for format reference (e.g. claw-checkpoint-cron.md, upgrade-to-opus-4-7.md).

Decision file frontmatter + sections:

---
type: decision
date: ${date}
status: active
tags: [relevant-tags]
---

# <Title>

## Context
<why this came up — 2-4 sentences>

## Options Considered
<numbered list of what was on the table, briefly each>

## Decision
<what was chosen + concrete files / commands / configs touched if applicable>

## Rationale
<why — bullets are fine>

## Verification
<how it was validated, if applicable>

## Related
<links to related decisions, files, contexts>

Decisions/ rules:
- Skip if a same-named file already exists for this decision.
- Skip trivia / hypotheticals — only ACTUAL choices that were made and acted on.
- Use kebab-case filenames matching the decision (e.g. per-message-context-injection.md, sick-day-status-flag.md).
- Reuse existing tags; common ones: claw, infra, memory, school, finance, project, tool.
- DO NOT git commit — the bot wrapper handles that.

` : ''}If nothing worth logging anywhere, output DONE without writing.
Output only: DONE`;

  try {
    const child = spawn('/root/.local/bin/claude', [
      '-p',
      '--no-session-persistence',
      '--model', resolveModel('sonnet'),
      '--permission-mode', 'bypassPermissions',
      '--add-dir', workDir,
      '--',
      prompt,
    ], {
      cwd: workDir,
      env: { ...process.env, HOME: '/root', IS_SANDBOX: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); log.warn(`[${topicName}/${date}] summarize timed out`); resolve(null); }, 60_000);
      child.on('close', (c) => { clearTimeout(timer); resolve(c); });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
    });

    if (code === 0) {
      log.info(`[${topicName}/${date}] Summarize done`);
      // Auto-commit any vault changes (Decisions/ backstop). Bash sandbox in claude
      // forbids operating inside nested git repos, so we do the commit out here.
      if (isOwnerWorkspace) {
        try {
          const vaultDir = resolve(WORKSPACE, 'obsidian-vault');
          execSync('git add -A && (git diff --cached --quiet || (git commit -m "$MSG" --quiet && git push --quiet))', {
            cwd: vaultDir,
            env: { ...process.env, MSG: `Claw: Decisions backstop ${topicSlug}/${date}` },
            timeout: 30_000,
          });
        } catch (e: any) {
          log.warn(`[${topicName}/${date}] vault auto-commit failed (non-fatal): ${e.message?.slice(0, 200)}`);
        }
      }
      return true;
    }
    log.warn(`[${topicName}/${date}] Summarize exited ${code}: ${stderr.slice(0, 300)}`);
    return false;
  } catch (e: any) {
    log.warn(`[${topicName}/${date}] Failed to summarize: ${e.message}`);
    return false;
  }
}

/** Per-topic mutex: serializes summarizeAndSave calls for the same topicId. */
const summarizeLocks = new Map<number, Promise<void>>();

/**
 * Summarize a session before clearing.
 * Splits transcript by date (5 AM CDT boundary) and runs per-date summarizers.
 * Uses session.lastSummarizedAt to skip already-processed messages (for periodic
 * checkpoint flushes); updates it to the max timestamp processed on full success.
 * Per-topic mutex prevents overlapping summarizations racing on the same session.
 */
export async function summarizeAndSave(topicId: number, topicName: string, workDirOverride?: string): Promise<void> {
  const prev = summarizeLocks.get(topicId) || Promise.resolve();
  const next = prev.then(() => doSummarizeAndSave(topicId, topicName, workDirOverride));
  const tail = next.catch(() => {});
  summarizeLocks.set(topicId, tail);
  try {
    await next;
  } finally {
    if (summarizeLocks.get(topicId) === tail) summarizeLocks.delete(topicId);
  }
}

async function doSummarizeAndSave(topicId: number, topicName: string, workDirOverride?: string): Promise<void> {
  const session = getSession(topicId);
  if (!session || session.messageCount <= 1) return;

  const topicConfig = TOPICS[topicId] || GUEST_TOPICS[topicId];
  const groupConfig = !topicConfig
    ? Object.values(GROUP_CHATS).find(g => Math.abs(Number(g.chatId)) === topicId)
    : null;
  const workDir = workDirOverride || topicConfig?.workspace || groupConfig?.workspace || WORKSPACE;

  const chatType: 'private' | 'group' = groupConfig ? 'group' : 'private';
  const chatId: string = groupConfig
    ? groupConfig.chatId
    : (GUEST_TOPICS[topicId] ? GUEST_CHAT_ID : CHAT_ID);
  const topicSlug = slugifyTopic(topicName, chatType);
  const sessionIdShort = session.sessionId.slice(0, 8);
  const dailyNotesDir = getDailyNotesDir(workDir);

  const sinceMs = session.lastSummarizedAt || 0;
  const { transcripts: transcriptsByDate, maxTimestamp } = extractTranscriptsByDate(session.sessionId, workDir, sinceMs);
  if (transcriptsByDate.size === 0) {
    if (sinceMs > 0) {
      log.info(`[${topicName}] No new messages since last checkpoint`);
    } else {
      log.warn(`[${topicName}] No transcript found for session ${session.sessionId}`);
    }
    return;
  }

  const dates = Array.from(transcriptsByDate.keys()).sort();

  log.info(`[${topicName}] Summarizing ${dates.length} date(s): ${dates.join(', ')}${sinceMs > 0 ? ' (incremental)' : ''}`);

  const results = await Promise.all(dates.map((date) =>
    runDateSummarizer(date, transcriptsByDate.get(date)!, topicName, topicSlug, chatType, chatId, sessionIdShort, workDir, dailyNotesDir),
  ));

  const allOk = results.every(Boolean);
  if (allOk && maxTimestamp > sinceMs) {
    setLastSummarizedAt(topicId, maxTimestamp);
    log.info(`[${topicName}] Checkpoint advanced to ${new Date(maxTimestamp).toISOString()}`);
  } else if (!allOk) {
    log.warn(`[${topicName}] Some dates failed; leaving lastSummarizedAt at ${sinceMs} for retry`);
  }
}

/**
 * Resolve the effective session key and display name for any context:
 * group chat, incognito (no topic), or regular topic.
 */
function resolveSessionContext(ctx: Context): { sessionKey: number; name: string; isGroup: boolean } | null {
  const chatIdStr = String(ctx.chat?.id || '');
  const groupConfig = GROUP_CHATS[chatIdStr];
  if (groupConfig) {
    return { sessionKey: Math.abs(Number(groupConfig.chatId)), name: groupConfig.name, isGroup: true };
  }
  const topicId = ctx.message?.message_thread_id;
  if (topicId) {
    const name = TOPICS[topicId]?.name || GUEST_TOPICS[topicId]?.name || `Topic-${topicId}`;
    return { sessionKey: topicId, name, isGroup: false };
  }
  // Incognito
  return { sessionKey: 0, name: 'Incognito', isGroup: false };
}

/** /clear — summarize session, then reset */
export async function clearCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  const chatIdStr = String(ctx.chat?.id || '');

  // Group chat: summarize, reset, warm up
  const groupConfig = GROUP_CHATS[chatIdStr];
  if (groupConfig) {
    const sessionKey = Math.abs(Number(groupConfig.chatId));
    const session = getSession(sessionKey);
    const topicConfigForRunner = {
      name: groupConfig.name,
      persona: groupConfig.persona,
      memory: groupConfig.memory,
      model: groupConfig.model,
      workspace: groupConfig.workspace,
    };

    if (session && session.messageCount > 0) {
      await ctx.reply('Saving memories before clearing...', { message_thread_id: topicId } as any);
      await summarizeAndSave(sessionKey, groupConfig.name, groupConfig.workspace);
    }

    reset(sessionKey);

    const editor = new ProgressiveEditor(ctx.api, groupConfig.chatId, null);
    const result = await runClaude(
      sessionKey, topicConfigForRunner,
      'Session was just cleared. Read your MEMORY.md, then send a brief greeting. One line max.',
      [], (acc) => { editor.update(acc).catch(() => {}); },
    );
    if (result.text) {
      await editor.finalize(result.text);
    } else {
      await ctx.reply('Session cleared.', { message_thread_id: topicId } as any);
    }
    return;
  }

  // Incognito mode: delete all messages + reset session, no summarize
  if (!topicId) {
    const chatId = chatIdStr || CHAT_ID;
    // Delete the /clear command message itself
    if (ctx.message?.message_id) {
      ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => {});
    }
    await clearIncognito(chatId, ctx.api);
    return;
  }

  const isGuest = ctx.from?.id === GUEST_USER_ID;
  const chatId = isGuest ? GUEST_CHAT_ID : CHAT_ID;
  const topicConfig = (isGuest ? GUEST_TOPICS : TOPICS)[topicId] || { name: `Topic-${topicId}`, persona: 'default.md', memory: null };
  const session = getSession(topicId);

  if (session && session.messageCount > 0) {
    await ctx.reply('Saving memories before clearing...', {
      message_thread_id: topicId,
    } as any);

    await summarizeAndSave(topicId, topicConfig.name);
  }

  reset(topicId);

  // Warm up new session — creates it and gets a greeting
  const editor = new ProgressiveEditor(ctx.api, chatId, topicId);
  const result = await runClaude(
    topicId, topicConfig,
    'Session was just cleared. Read your topic memory and daily notes, then send a brief greeting. One line max.',
    [], (acc) => { editor.update(acc).catch(() => {}); },
  );
  if (result.text) {
    await editor.finalize(result.text);
  } else {
    await ctx.reply('Session cleared.', { message_thread_id: topicId } as any);
  }
}

/** /compact — summarize and reset, next message restores from memory */
export async function compactCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  const chatIdStr = String(ctx.chat?.id || '');

  // Group chat: compact = summarize + reset + warm up
  const groupConfig = GROUP_CHATS[chatIdStr];
  if (groupConfig) {
    const sessionKey = Math.abs(Number(groupConfig.chatId));
    const session = getSession(sessionKey);
    const topicConfigForRunner = {
      name: groupConfig.name,
      persona: groupConfig.persona,
      memory: groupConfig.memory,
      model: groupConfig.model,
      workspace: groupConfig.workspace,
    };

    if (session && session.messageCount > 0) {
      await ctx.reply('Compacting — saving memories...', { message_thread_id: topicId } as any);
      await summarizeAndSave(sessionKey, groupConfig.name, groupConfig.workspace);
    }

    reset(sessionKey);

    const editor = new ProgressiveEditor(ctx.api, groupConfig.chatId, null);
    const result = await runClaude(
      sessionKey, topicConfigForRunner,
      'Session was compacted. Read your MEMORY.md and recent daily notes to restore context. Send a brief greeting acknowledging what you remember. One line max.',
      [], (acc) => { editor.update(acc).catch(() => {}); },
    );
    if (result.text) {
      await editor.finalize(result.text);
    } else {
      await ctx.reply('Compacted.', { message_thread_id: topicId } as any);
    }
    return;
  }

  // Incognito: compact doesn't make sense, just clear
  if (!topicId) {
    await ctx.reply('Use /clear for incognito.');
    return;
  }

  const isGuest = ctx.from?.id === GUEST_USER_ID;
  const chatId = isGuest ? GUEST_CHAT_ID : CHAT_ID;
  const topicConfig = (isGuest ? GUEST_TOPICS : TOPICS)[topicId] || { name: `Topic-${topicId}`, persona: 'default.md', memory: null };
  const session = getSession(topicId);

  if (session && session.messageCount > 0) {
    await ctx.reply('Compacting — saving memories...', {
      message_thread_id: topicId,
    } as any);

    await summarizeAndSave(topicId, topicConfig.name);
  }

  reset(topicId);

  // Warm up new session with memory restoration
  const editor = new ProgressiveEditor(ctx.api, chatId, topicId);
  const result = await runClaude(
    topicId, topicConfig,
    'Session was compacted. Read your topic memory and recent daily notes to restore context. Send a brief greeting acknowledging what you remember. One line max.',
    [], (acc) => { editor.update(acc).catch(() => {}); },
  );
  if (result.text) {
    await editor.finalize(result.text);
  } else {
    await ctx.reply('Compacted.', { message_thread_id: topicId } as any);
  }
}

/** /status — show all topic sessions */
export async function statusCommand(ctx: Context): Promise<void> {
  const sessions = listSessions();
  if (sessions.length === 0) {
    await ctx.reply('No active sessions.', {
      message_thread_id: ctx.message?.message_thread_id,
    } as any);
    return;
  }

  const lines = sessions
    .filter((s) => {
      // Hide 0-message sessions and orphan topic IDs (not in any config)
      if (s.messageCount === 0) return false;
      const id = Number(s.topicId);
      if (id === 0) return true; // incognito
      if (TOPICS[id] || GUEST_TOPICS[id]) return true;
      if (Object.values(GROUP_CHATS).some((g) => Math.abs(Number(g.chatId)) === id)) return true;
      return false; // orphan — skip
    })
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .map((s) => {
      const id = Number(s.topicId);
      let name: string;
      if (id === 0) {
        name = 'Incognito';
      } else {
        const topic = TOPICS[id] || GUEST_TOPICS[id];
        const group = Object.values(GROUP_CHATS).find((g) => Math.abs(Number(g.chatId)) === id);
        name = topic?.name || group?.name || `Topic-${id}`;
      }
      const ago = Math.round((Date.now() - s.lastUsedAt) / 60_000);
      let ckpt: string;
      if (s.lastSummarizedAt) {
        const m = Math.round((Date.now() - s.lastSummarizedAt) / 60_000);
        const age = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
        ckpt = `ckpt ${age} ago`;
      } else {
        ckpt = 'ckpt never';
      }
      return `• ${name}: ${s.messageCount} msgs, ${s.model}, ${s.effort || 'auto'}, ${ago}m ago, ${ckpt}`;
    });

  const q = getQueueStats();
  const pg = getPendingGroupCount();
  const runtime = `Runtime: ${q.active}/${MAX_CONCURRENT} active, ${q.waiting} queued, ${q.busyTopics} busy ${q.busyTopics === 1 ? 'topic' : 'topics'}, ${pg} media ${pg === 1 ? 'group' : 'groups'}`;

  await ctx.reply(`Active sessions:\n${lines.join('\n')}\n\n${runtime}`, {
    message_thread_id: ctx.message?.message_thread_id,
  } as any);
}

/**
 * /focus — manually-set lens that biases all the owner's DM replies for a stretch.
 * Persists across topics/sessions. Injected as `[Focus: <text>]` per message
 * by prompt-builder. Auto-clears at expiry (default 7d, max 60d).
 *
 * Usage:
 *   /focus                            — show current focus + remaining time
 *   /focus <text>                     — set with default 7d expiry
 *   /focus <text> for <N>(h|d|w)      — set with custom TTL
 *   /focus off | clear | none         — clear immediately
 *
 * Examples:
 *   /focus finals week, exam Friday
 *   /focus sick, low energy for 3d
 *   /focus launch sprint for 2w
 */
export async function focusCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  const reply = (msg: string) => ctx.reply(msg, { message_thread_id: topicId } as any);

  // the owner-only — Guest/groups must not touch the owner's focus state.
  if (ctx.from?.id !== OWNER_USER_ID) {
    await reply('Focus is the owner-only.');
    return;
  }

  const focusPath = resolve(WORKSPACE, 'state/context/focus.json');
  const text = (ctx.message?.text || '').replace(/^\/focus(@\S+)?\s*/, '').trim();

  // No args — show current
  if (!text) {
    try {
      const data = JSON.parse(readFileSync(focusPath, 'utf-8'));
      const expiresAt = new Date(data.expires_at);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) {
        await reply('No focus set.\n\nUsage: /focus <text> [for <N>d|w]\n/focus off — clear');
        return;
      }
      const remainMs = expiresAt.getTime() - Date.now();
      const remainDays = (remainMs / 86_400_000).toFixed(1);
      await reply(`Focus: ${data.text}\nExpires in ${remainDays}d (set ${new Date(data.set_at).toLocaleString('en-US', { timeZone: 'America/Chicago' })})`);
    } catch {
      await reply('No focus set.\n\nUsage: /focus <text> [for <N>d|w]\n/focus off — clear');
    }
    return;
  }

  // Clear
  if (/^(off|clear|none)$/i.test(text)) {
    try {
      unlinkSync(focusPath);
      await reply('Focus cleared.');
    } catch {
      await reply('No focus was set.');
    }
    return;
  }

  // Set: parse optional `for <N><unit>` TTL suffix
  const ttlRe = /^(.+?)\s+for\s+(\d+)\s*(h|d|w)\s*$/i;
  const m = text.match(ttlRe);
  let body: string;
  let ttlMs: number;
  if (m) {
    body = m[1].trim();
    const n = Number(m[2]);
    const unit = m[3].toLowerCase();
    const unitMs = unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
    ttlMs = n * unitMs;
  } else {
    body = text;
    ttlMs = 7 * 86_400_000;
  }

  if (!body) {
    await reply('Usage: /focus <text> [for <N>d|w]');
    return;
  }
  // Caps: max 60d TTL, 200-char body
  ttlMs = Math.max(3_600_000, Math.min(ttlMs, 60 * 86_400_000));
  if (body.length > 200) body = body.slice(0, 200);

  const setAt = new Date();
  const expiresAt = new Date(setAt.getTime() + ttlMs);
  const data = {
    text: body,
    set_at: setAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  mkdirSync(dirname(focusPath), { recursive: true });
  writeFileSync(focusPath, JSON.stringify(data, null, 2));

  const days = (ttlMs / 86_400_000).toFixed(1);
  await reply(`Focus set: ${body}\nExpires in ${days}d`);
}

/** /model <model> — set model for current topic/group/incognito */
export async function modelCommand(ctx: Context): Promise<void> {
  const sc = resolveSessionContext(ctx);
  if (!sc) return;

  const text = ctx.message?.text || '';
  const model = text.split(/\s+/)[1];
  const valid = ['sonnet', 'opus', 'haiku'];

  if (!model || !valid.includes(model)) {
    const entry = getOrCreate(sc.sessionKey);
    await ctx.reply(`Current: ${entry.model}\nUsage: /model <${valid.join('|')}>`, {
      message_thread_id: ctx.message?.message_thread_id,
    } as any);
    return;
  }

  getOrCreate(sc.sessionKey);
  setModel(sc.sessionKey, model);
  await ctx.reply(`Model set to ${model} for ${sc.name}.`, {
    message_thread_id: ctx.message?.message_thread_id,
  } as any);
}

/** /effort <level> — set effort level for current topic/group/incognito */
export async function effortCommand(ctx: Context): Promise<void> {
  const sc = resolveSessionContext(ctx);
  if (!sc) return;

  const text = ctx.message?.text || '';
  const level = text.split(/\s+/)[1];
  const valid = ['low', 'medium', 'high', 'max', 'auto'];

  if (!level || !valid.includes(level)) {
    const entry = getOrCreate(sc.sessionKey);
    await ctx.reply(`Current: ${entry.effort || 'auto'}\nUsage: /effort <${valid.join('|')}>`, {
      message_thread_id: ctx.message?.message_thread_id,
    } as any);
    return;
  }

  getOrCreate(sc.sessionKey);
  setEffort(sc.sessionKey, level);
  await ctx.reply(`Effort set to ${level} for ${sc.name}.`, {
    message_thread_id: ctx.message?.message_thread_id,
  } as any);
}

/** /task <text> — add task to tasks.json */
export async function taskCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  const text = (ctx.message?.text || '').replace(/^\/(task|todo)\s*/, '').trim();

  if (!text) {
    await ctx.reply('Usage: /task <description>', {
      message_thread_id: topicId,
    } as any);
    return;
  }

  try {
    const vaultDir = resolve(WORKSPACE, 'obsidian-vault');

    // Pull latest before reading
    try { execSync('git pull --rebase --quiet', { cwd: vaultDir, timeout: 10_000 }); } catch {}

    const tasksPath = resolve(vaultDir, 'tasks.json');
    const raw = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    const tasks = Array.isArray(raw) ? raw : (raw.tasks || []);

    const task = {
      id: randomUUID(),
      title: text,
      description: '',
      category: 'personal',
      effort: 'M',
      deadline: null,
      addedAt: new Date().toISOString(),
      status: 'open',
      completedAt: null,
      score: 0,
      tags: [],
    };

    tasks.push(task);
    const output = Array.isArray(raw) ? tasks : { ...raw, tasks };
    writeFileSync(tasksPath, JSON.stringify(output, null, 2));

    // Safe: write commit message to env var to avoid shell injection
    execSync('git add tasks.json && git commit -m "$TASK_MSG" && git push', {
      cwd: vaultDir,
      env: { ...process.env, TASK_MSG: `Add task: ${text}` },
    });

    await ctx.reply(`Added: ${text}`, {
      message_thread_id: topicId,
    } as any);
  } catch (e: any) {
    log.error('Task add failed:', e.message);
    await ctx.reply(`Failed to add task: ${e.message}`, {
      message_thread_id: topicId,
    } as any);
  }
}

/** /idea <text> — capture idea to inbox.json */
export async function ideaCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  const text = (ctx.message?.text || '').replace(/^\/idea\s*/, '').trim();

  if (!text) {
    await ctx.reply('Usage: /idea <description>', {
      message_thread_id: topicId,
    } as any);
    return;
  }

  try {
    const inboxPath = resolve(WORKSPACE, 'state/ideas/inbox.json');
    let inbox: any[];
    try {
      inbox = JSON.parse(readFileSync(inboxPath, 'utf-8'));
    } catch {
      inbox = [];
    }

    inbox.push({
      id: randomUUID(),
      text,
      addedAt: new Date().toISOString(),
      status: 'pending',
      tags: [],
    });

    writeFileSync(inboxPath, JSON.stringify(inbox, null, 2));

    await ctx.reply('Logged — overnight research queued.', {
      message_thread_id: topicId,
    } as any);
  } catch (e: any) {
    log.error('Idea capture failed:', e.message);
    await ctx.reply(`Failed to log idea: ${e.message}`, {
      message_thread_id: topicId,
    } as any);
  }
}

interface CronJob { name: string; timer: string; service: string; enabled: boolean }

/** Parse `systemctl show` multi-unit output (blocks split by blank lines) into Id->value maps. */
function parseShowBlocks(out: string, key: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of out.split(/\n\s*\n/)) {
    let id = '', val = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('Id=')) id = line.slice(3).trim();
      else if (line.startsWith(`${key}=`)) val = line.slice(key.length + 1).trim();
    }
    if (id) map.set(id, val);
  }
  return map;
}

/**
 * Auto-discover all claw-*.timer units (drift-proof — no hardcoded list).
 * Resolves each timer to the service it activates via Unit= (e.g.
 * claw-teller-snapshot-frequent.timer -> claw-teller-snapshot.service), so the
 * timer/service base names need not match. Friendly name strips the
 * claw-/claw-cron- prefix. Sorted by name.
 */
function discoverCronJobs(): CronJob[] {
  const listed = execSync(`systemctl list-unit-files 'claw-*.timer' --no-legend --no-pager`, { encoding: 'utf8', timeout: 5000 });
  const rows = listed.trim().split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const parts = l.split(/\s+/);
    return { timer: parts[0], state: parts[1] || '' };
  });
  if (rows.length === 0) return [];
  const timerToService = parseShowBlocks(
    execSync(`systemctl show ${rows.map(r => r.timer).join(' ')} --property=Id,Unit --no-pager`, { encoding: 'utf8', timeout: 5000 }),
    'Unit',
  );
  return rows.map(r => ({
    name: r.timer.replace(/\.timer$/, '').replace(/^claw-(cron-)?/, ''),
    timer: r.timer,
    service: timerToService.get(r.timer) || r.timer.replace(/\.timer$/, '.service'),
    enabled: r.state === 'enabled',
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** /cron — manage cron jobs */
export async function cronCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;

  // the owner-only — cron controls systemd timers/services; Guest/groups must not touch them.
  if (ctx.from?.id !== OWNER_USER_ID) {
    await ctx.reply('Cron: the owner only.', { message_thread_id: topicId } as any);
    return;
  }

  const args = (ctx.message?.text || '').split(/\s+/).slice(1);
  const sub = args[0];
  const jobName = args[1];

  let jobs: CronJob[];
  try {
    jobs = discoverCronJobs();
  } catch (e: any) {
    await ctx.reply(`Cron discovery failed: ${e.message?.slice(0, 150)}`, { message_thread_id: topicId } as any);
    return;
  }
  if (jobs.length === 0) {
    await ctx.reply('No claw-*.timer units found.', { message_thread_id: topicId } as any);
    return;
  }

  if (!sub) {
    // Show status of all discovered cron jobs (last-run Result batched in one call).
    let resultMap = new Map<string, string>();
    try {
      const services = [...new Set(jobs.map(j => j.service))].join(' ');
      resultMap = parseShowBlocks(
        execSync(`systemctl show ${services} --property=Id,Result --no-pager`, { encoding: 'utf8', timeout: 5000 }),
        'Result',
      );
    } catch {}
    const lines: string[] = [`Cron Jobs (${jobs.length}):`];
    for (const job of jobs) {
      const result = resultMap.get(job.service) || 'unknown';
      const icon = result === 'success' ? '✅' : result === 'unknown' ? '⏳' : '❌';
      lines.push(`${icon} ${job.name} [${job.enabled ? 'on' : 'off'}]`);
    }
    lines.push('\nUsage: /cron <run|enable|disable> <job>');
    await ctx.reply(lines.join('\n'), { message_thread_id: topicId } as any);
    return;
  }

  const job = jobName ? jobs.find(j => j.name === jobName) : undefined;
  if (!job) {
    await ctx.reply(`Jobs: ${jobs.map(j => j.name).join(', ')}`, { message_thread_id: topicId } as any);
    return;
  }

  // Pass discovered unit names (not raw user input) to systemctl — no injection surface.
  try {
    if (sub === 'run') {
      execSync(`systemctl start ${job.service} --no-block`, { timeout: 5000 });
      await ctx.reply(`Triggered ${job.name}. Check the target topic.`, { message_thread_id: topicId } as any);
    } else if (sub === 'enable') {
      execSync(`systemctl enable --now ${job.timer}`, { timeout: 5000 });
      await ctx.reply(`Enabled ${job.name} timer.`, { message_thread_id: topicId } as any);
    } else if (sub === 'disable') {
      execSync(`systemctl disable --now ${job.timer}`, { timeout: 5000 });
      await ctx.reply(`Disabled ${job.name} timer.`, { message_thread_id: topicId } as any);
    } else {
      await ctx.reply('Usage: /cron <run|enable|disable> <job>', { message_thread_id: topicId } as any);
    }
  } catch (e: any) {
    await ctx.reply(`Failed: ${e.message?.slice(0, 200)}`, { message_thread_id: topicId } as any);
  }
}

/** /stop — kill the active Claude process for this topic/group/incognito */
export async function stopCommand(ctx: Context): Promise<void> {
  const sc = resolveSessionContext(ctx);
  if (!sc) return;
  const stopped = stopTopic(sc.sessionKey);
  await ctx.reply(stopped ? 'Stopped.' : 'Nothing running.', {
    message_thread_id: ctx.message?.message_thread_id,
  } as any);
}

/**
 * Get the true tracking-start timestamp. Derived once from the first
 * claw-bot journald entry and cached to stats-meta.json so log rotation
 * can't erase it.
 */
function getTrackingStartMs(): number {
  const metaPath = resolve(BOT_DIR, 'stats-meta.json');
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (meta.trackingSinceMs) return Number(meta.trackingSinceMs);
  } catch {}

  let trackingSinceMs = 0;
  try {
    const line = execSync(
      'journalctl -u claw-bot --output=short-iso --no-pager 2>/dev/null | head -1',
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    const iso = line.split(' ')[0];
    if (iso) trackingSinceMs = new Date(iso).getTime();
  } catch {}

  if (!trackingSinceMs) trackingSinceMs = Date.now();

  try {
    writeFileSync(metaPath, JSON.stringify({ trackingSinceMs }, null, 2));
  } catch {}

  return trackingSinceMs;
}

/** /stats — show bot usage stats (cost, tokens, top topics) */
export async function statsCommand(ctx: Context): Promise<void> {
  const topicId = ctx.message?.message_thread_id;
  try {
    const sessionsPath = resolve(BOT_DIR, 'sessions.json');
    const sessions = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as Record<string, any>;

    const nameFor = (key: string): string => {
      if (key === '0') return 'Incognito';
      const id = Number(key);
      if (TOPICS[id]) return TOPICS[id].name;
      if (GUEST_TOPICS[id]) return GUEST_TOPICS[id].name;
      const group = Object.values(GROUP_CHATS).find((g) => Math.abs(Number(g.chatId)) === id);
      if (group) return group.name;
      return `Topic ${key}`;
    };

    let totalCost = 0, totalIn = 0, totalOut = 0, totalMsgs = 0;
    const rows: { name: string; cost: number; model: string; msgs: number }[] = [];

    for (const [key, data] of Object.entries(sessions)) {
      const cost = Number(data.totalCostUsd || 0);
      const inp = Number(data.totalInputTokens || 0);
      const out = Number(data.totalOutputTokens || 0);
      const msgs = Number(data.messageCount || 0);
      totalCost += cost;
      totalIn += inp;
      totalOut += out;
      totalMsgs += msgs;
      if (cost > 0) rows.push({ name: nameFor(key), cost, model: data.model || '?', msgs });
    }

    rows.sort((a, b) => b.cost - a.cost);
    const top = rows.slice(0, 6);

    const trackingSinceMs = getTrackingStartMs();
    const days = Math.max(1, Math.round((Date.now() - trackingSinceMs) / 86400_000));

    const lines = [
      `📊 Claw usage (all-time, ${days}d)`,
      ``,
      `Metered-equivalent: $${totalCost.toFixed(2)}`,
      `Input:  ${(totalIn / 1e6).toFixed(1)}M tokens`,
      `Output: ${(totalOut / 1e6).toFixed(2)}M tokens`,
      `Messages: ${totalMsgs}`,
      ``,
      `Top topics:`,
      ...top.map((r) => {
        const pct = totalCost > 0 ? ((r.cost / totalCost) * 100).toFixed(1) : '0.0';
        return `• ${r.name}: $${r.cost.toFixed(2)} (${pct}%, ${r.model})`;
      }),
      ``,
      `Monthly rate: $${(totalCost / Math.max(days / 30.44, 1 / 30.44)).toFixed(2)}/mo`,
      `vs Max 20 ($200/mo): ${(totalCost / Math.max(days / 30.44, 1 / 30.44) / 200).toFixed(1)}x value`,
    ];

    await ctx.reply(lines.join('\n'), { message_thread_id: topicId } as any);
  } catch (e: any) {
    log.error('Stats command failed:', e.message);
    await ctx.reply(`Failed to compute stats: ${e.message}`, { message_thread_id: topicId } as any);
  }
}

/** /help — list commands */
export async function helpCommand(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      'Claw v2 Commands:',
      '/clear — save memories + reset session',
      '/compact — save memories + reset (reads memory on next msg)',
      '/stop — cancel current response',
      '/status — show all active sessions',
      '/stats — show cost, tokens, top topics',
      '/model <sonnet|opus|haiku> — set model for this topic',
      '/effort <low|medium|high|max|auto> — set effort level',
      '/cron — manage cron jobs (run/enable/disable)',
      '/focus <text> [for <N>d|w] — set context lens (default 7d, /focus off to clear)',
      '/task <text> — add a task',
      '/idea <text> — capture an idea',
      '/help — this message (alias: /start)',
    ].join('\n'),
    { message_thread_id: ctx.message?.message_thread_id } as any,
  );
}
