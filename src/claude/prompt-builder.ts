import { readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { PERSONAS_DIR, WORKSPACE, GUEST_WORKSPACE, CONTEXT_REINJECT_EVERY, type TopicConfig, type GroupChatConfig } from '../config.js';
import { log } from '../util/logger.js';

/**
 * Per-message context header for the owner's DMs only. Two pieces:
 *   1. Calendar tail — live events / events starting in <=30 min / today's all-day
 *      items. Refreshed every 5 min by claw-context-refresh.timer into
 *      state/context/calendar.json. We just read pre-formatted lines.
 *   2. Daily-note tail — last few entries from state/memory/YYYY-MM-DD.md across
 *      all topics. Plugs the cross-topic awareness gap: a session in `settings`
 *      sees decisions made minutes ago in `coding`, etc. Re-read every message
 *      because file reads are cheap.
 *
 * Skipped for Guest's isolated workspace and for group chats. If anything
 * fails, we silently emit nothing — never break the message path.
 */

const CALENDAR_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // hide if refresh stalled >30min
const DAILY_NOTE_TAIL_COUNT = 4;
const DAILY_NOTE_BODY_MAX_CHARS = 110;
const LIVE_FEED_WINDOW_MS = 30 * 60 * 1000;        // surface activity from the last 30 min
const LIVE_FEED_MAX_TOPICS = 3;                     // at most 3 distinct other topics
const LIVE_FEED_DISPLAY_CHARS = 70;                 // per side (user/claw) in the [Live] line

/**
 * the owner's currently-detected timezone, written by refresh-context.mjs based on
 * latest "X → Y" flight calendar event. Falls back to America/Chicago when no
 * detection has happened yet. Guest's workspace ignores this and stays on MSK.
 */
function readDetectedTz(): string {
  try {
    const d = JSON.parse(readFileSync(resolve(WORKSPACE, 'state/context/timezone.json'), 'utf-8'));
    if (typeof d.tz === 'string' && d.tz) return d.tz;
  } catch {}
  return 'America/Chicago';
}

function readFocusLine(): string | null {
  const path = resolve(WORKSPACE, 'state/context/focus.json');
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof data.text !== 'string' || !data.text) return null;
    const expiresAt = new Date(data.expires_at);
    if (Number.isNaN(expiresAt.getTime())) return null;
    if (expiresAt < new Date()) {
      try { unlinkSync(path); } catch {} // auto-clean expired
      return null;
    }
    return `[Focus: ${data.text}]`;
  } catch {
    return null;
  }
}

function readCalendarLines(): string[] {
  const path = resolve(WORKSPACE, 'state/context/calendar.json');
  try {
    const stat = statSync(path);
    if (Date.now() - stat.mtimeMs > CALENDAR_CACHE_MAX_AGE_MS) return [];
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data?.lines) ? data.lines.filter((l: unknown) => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

function todayChicago(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

interface DailyNoteEntry {
  topic: string;
  hhmm: string;
  body: string;
}

function parseDailyNoteTail(filePath: string, count: number): DailyNoteEntry[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch { return []; }

  // Each entry has THREE `---` separator lines: FM-open, FM-close/body-start, body-end.
  // Walk lines with a state machine so blank lines between entries don't desync us.
  const SEP = /^---\s*$/;
  const lines = raw.split('\n');
  const entries: DailyNoteEntry[] = [];
  let state: 0 | 1 | 2 = 0; // 0=outside, 1=in FM, 2=in body
  let fm: string[] = [];
  let body: string[] = [];

  for (const line of lines) {
    if (SEP.test(line)) {
      if (state === 0) { state = 1; fm = []; body = []; }
      else if (state === 1) { state = 2; }
      else {
        const parsed = parseEntry(fm, body);
        if (parsed) entries.push(parsed);
        state = 0;
      }
    } else if (state === 1) { fm.push(line); }
    else if (state === 2) { body.push(line); }
  }
  return entries.slice(-count);

  function parseEntry(fmLines: string[], bodyLines: string[]): DailyNoteEntry | null {
    const fmText = fmLines.join('\n');
    const topic = (fmText.match(/^topic:\s*(.+)$/m)?.[1] ?? '').trim();
    const ts    = (fmText.match(/^timestamp:\s*(.+)$/m)?.[1] ?? '').trim();
    if (!topic || !ts) return null;
    const t = new Date(ts);
    if (Number.isNaN(t.getTime())) return null;
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: readDetectedTz(), hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(t);
    const firstLine = bodyLines.map(s => s.trim()).find(Boolean) ?? '';
    const trimmed = firstLine.length > DAILY_NOTE_BODY_MAX_CHARS
      ? firstLine.slice(0, DAILY_NOTE_BODY_MAX_CHARS - 1) + '…'
      : firstLine;
    return { topic, hhmm, body: trimmed };
  }
}

function readLiveFeedLine(currentTopicId: number | undefined): string | null {
  const path = resolve(WORKSPACE, 'state/context/live-feed.jsonl');
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch { return null; }
  const cutoff = Date.now() - LIVE_FEED_WINDOW_MS;
  const all: Array<{ ts: string; topic_id: number; topic: string; user: string; claw: string }> = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.topic_id !== 'number') continue;
      if (currentTopicId && e.topic_id === currentTopicId) continue; // skip self
      const ts = new Date(e.ts).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      all.push(e);
    } catch {}
  }
  if (all.length === 0) return null;

  // One entry per distinct other topic, latest-first, then capped.
  const seen = new Set<number>();
  const picked: typeof all = [];
  for (let i = all.length - 1; i >= 0 && picked.length < LIVE_FEED_MAX_TOPICS; i--) {
    if (seen.has(all[i].topic_id)) continue;
    seen.add(all[i].topic_id);
    picked.push(all[i]);
  }
  picked.reverse();

  const cropForDisplay = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > LIVE_FEED_DISPLAY_CHARS ? t.slice(0, LIVE_FEED_DISPLAY_CHARS - 1) + '…' : t;
  };

  const tz = readDetectedTz();
  const formatted = picked.map(e => {
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(e.ts));
    return `${hhmm} ${e.topic.toLowerCase()}: "${cropForDisplay(e.user)}" → "${cropForDisplay(e.claw)}"`;
  }).join(' · ');

  return `[Live (last 30m, other topics): ${formatted}]`;
}

function readDailyNoteLine(): string | null {
  const memDir = resolve(WORKSPACE, 'state/memory');
  // Try today first; fall back to yesterday across midnight before today's file exists.
  let path = resolve(memDir, `${todayChicago()}.md`);
  if (!existsSync(path)) {
    const y = new Date(Date.now() - 24 * 3_600 * 1000);
    const yparts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(y);
    const yget = (t: string) => yparts.find(p => p.type === t)?.value ?? '';
    const ystr = `${yget('year')}-${yget('month')}-${yget('day')}`;
    path = resolve(memDir, `${ystr}.md`);
    if (!existsSync(path)) return null;
  }
  const tail = parseDailyNoteTail(path, DAILY_NOTE_TAIL_COUNT);
  if (tail.length === 0) return null;
  const compact = tail.map(e => `${e.hhmm} · ${e.topic} · ${e.body}`).join(' · ');
  return `[Recent: ${compact}]`;
}

/**
 * Build the per-message context header (calendar + daily-note tail).
 * Returns the lines as an array; caller stitches them in. Empty array on any
 * failure (best-effort, never breaks message flow).
 */
export function buildContextHeaderLines(topicConfig: TopicConfig, currentTopicId?: number): string[] {
  if (topicConfig.workspace === GUEST_WORKSPACE) return [];
  const lines: string[] = [];
  try {
    const focus = readFocusLine();
    if (focus) lines.push(focus);
    lines.push(...readCalendarLines());
    const live = readLiveFeedLine(currentTopicId);
    if (live) lines.push(live);
    const dn = readDailyNoteLine();
    if (dn) lines.push(dn);
  } catch (err) {
    log.warn(`buildContextHeaderLines failed: ${(err as Error).message}`);
    return [];
  }
  return lines;
}

/**
 * Format current time for a given IANA timezone as `YYYY-MM-DD HH:MM <ABBR>`.
 * e.g. `2026-05-04 20:35 CDT` or `2026-05-05 04:35 MSK`.
 * Used to inject per-message timestamps so Claude knows when a user message arrived
 * (the SDK only injects today's date in the system prompt, not the current hour).
 *
 * Node's Intl returns "GMT+3" for non-US zones — we hard-map the zones we use so
 * the readable abbreviation reaches Claude.
 */
const TZ_ABBR: Record<string, string> = {
  'America/Chicago': 'CDT',
  'America/New_York': 'EDT',
  'America/Los_Angeles': 'PDT',
  'America/Toronto': 'EDT',
  'America/Mexico_City': 'CST',
  'Europe/Moscow': 'MSK',
  'Europe/London': 'BST',
  'Europe/Paris': 'CEST',
  'Europe/Berlin': 'CEST',
  'Europe/Amsterdam': 'CEST',
  'Europe/Istanbul': 'TRT',
  'Asia/Singapore': 'SGT',
  'Asia/Tokyo': 'JST',
  'Asia/Dubai': 'GST',
  'Asia/Qatar': 'AST',
  'Asia/Bangkok': 'ICT',
  'Asia/Hong_Kong': 'HKT',
  'Asia/Seoul': 'KST',
  'Asia/Shanghai': 'CST',
  'Australia/Sydney': 'AEST',
};

export function formatTimeForZone(timeZone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  const abbr = TZ_ABBR[timeZone] ?? new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? timeZone;
  return `${date} ${time} ${abbr}`;
}

/**
 * Read a persona file from personas/ directory.
 * Returns the content or a fallback default prompt.
 */
export function readPersona(personaFile: string): string {
  try {
    return readFileSync(resolve(PERSONAS_DIR, personaFile), 'utf-8').trim();
  } catch {
    log.warn(`Persona file not found: ${personaFile}, using default`);
    return 'You are Claw. Default persona: concise, high-signal, engineer-to-engineer.';
  }
}

/**
 * Build the system prompt for a GROUP CHAT session.
 * Injects persona + chat history. Does NOT inject MEMORY.md or TOOLS.md.
 */
export function buildGroupSystemPrompt(groupConfig: GroupChatConfig, chatHistory: string): string {
  const persona = readPersona(groupConfig.persona);
  const parts = [persona];

  if (chatHistory) {
    parts.push(`\n<chat-history>\n${chatHistory}\n</chat-history>`);
  }

  if (groupConfig.memory) {
    parts.push(`\nRead ${resolve(groupConfig.workspace, groupConfig.memory)} for group context on your first turn.`);
  }

  // Security boundary — explicitly tell Claude not to access files outside its workspace
  parts.push(`\nIMPORTANT: Your workspace is ${groupConfig.workspace}. Do NOT read, write, or access any files outside this directory. You do not have access to other users' data.`);

  // Privacy boundary — group-chat output is public to every member. Never surface
  // anything from the owner's private DMs, 1:1 chats, emails, or personal notes, even
  // if such context somehow appears in your prompt. Only discuss topics raised by
  // the group itself.
  parts.push(`\nCRITICAL PRIVACY RULE: Your output in this group is PUBLIC to every member. NEVER quote, paraphrase, or reference the owner's private DMs, 1:1 conversations, family messages, emails, calendar, financial data, or anything from <recent-telegram> context — even if it appears in your prompt. If asked about such things, decline briefly. Discuss only what the group itself has said.`);

  // Memory override — see buildSystemPrompt for rationale.
  parts.push(`\nMEMORY OVERRIDE: Disregard the entire "auto memory" section in the harness preamble. Your only memory is this group's workspace at ${groupConfig.workspace}. ~/.claude/projects/ holds session transcripts, NOT memory — never read, write, or grep it as a memory store. NEVER create files matching \`feedback_*.md\`, \`user_*.md\`, \`project_*.md\`, \`reference_*.md\`, or any other "one memory per file" pattern from the SDK preamble — that two-step process (file + MEMORY.md pointer) does NOT apply here. To save lasting feedback/preferences, edit MEMORY.md directly with a new bullet under the relevant section. To save daily context, append to memory/YYYY-MM-DD.md. That is it.`);

  return parts.join('\n');
}

/**
 * Build the user prompt with topic context prefix.
 * This prefix tells Claude which topic it's in (used on every message, including resume).
 *
 * Telegram context is NOT auto-injected. Claude must pull it via CLI when needed.
 * (Auto-injection was removed to avoid tone-bleed / token-waste / cache-busting.)
 */
export function buildUserPrompt(
  topicConfig: TopicConfig,
  topicId: number,
  userMessage: string,
  attachments: string[] = [],
  _isGroupChat: boolean = false,
  turnNumber: number = 0,
): string {
  const parts: string[] = [];

  parts.push(`[Topic: ${topicConfig.name} (${topicId})]`);

  // Per-message timestamp. Guest's workspace -> Moscow (fixed). the owner's workspace
  // uses the auto-detected tz (latest "X → Y" flight in calendar), falling back
  // to Chicago. Read fresh per message — refresh-context.mjs updates it every 5 min.
  const tz = topicConfig.workspace === GUEST_WORKSPACE ? 'Europe/Moscow' : readDetectedTz();
  parts.push(`[Time: ${formatTimeForZone(tz)}]`);

  // Live context for the owner's DMs only (focus + calendar + cross-topic live + daily-note tail).
  parts.push(...buildContextHeaderLines(topicConfig, topicId));

  for (const path of attachments) {
    parts.push(`[Attached: ${path}]`);
  }

  // Periodic context reminder. The system prompt carries persona + MEMORY.md +
  // SESSION_PROTOCOL.md + TOOLS.md + topic memory + the MEMORY OVERRIDE rule
  // once at session creation; over long sessions, rules buried inside them fade
  // out of attention (2026-05-14: Coach forgot the "ALWAYS save full workout
  // log" line at topic-coach.md:22 after ~40 turns). Re-paste everything every
  // Nth user turn so the rules get a recency boost. N is global config with
  // per-topic override; 0 disables.
  const reinjectEvery = topicConfig.reinjectEvery ?? CONTEXT_REINJECT_EVERY;
  if (reinjectEvery > 0 && turnNumber > 0 && turnNumber % reinjectEvery === 0) {
    const reminder = buildPeriodicReminderBlock(topicConfig);
    if (reminder) parts.push(`\n${reminder}`);
  }

  parts.push(userMessage);

  return parts.join('\n');
}

/**
 * Read a file if it exists, return null otherwise.
 */
function readOptional(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * The "do not use ~/.claude/projects/ as memory" rule. Shared between
 * `buildSystemPrompt` (initial injection) and `buildPeriodicReminderBlock`
 * (periodic re-injection) so they stay in sync.
 */
const MEMORY_OVERRIDE_TEXT = `MEMORY OVERRIDE: Disregard the entire "auto memory" section in the harness preamble. Your memory is the <memory> and <topic-memory> blocks above plus state/memory/ on disk. The dir ~/.claude/projects/ holds session transcripts, NOT memory — never read, write, or grep it as a memory store. NEVER create files matching \`feedback_*.md\`, \`user_*.md\`, \`project_*.md\`, \`reference_*.md\`, or any other "one memory per file" pattern from the SDK preamble — that two-step process (file + MEMORY.md pointer) does NOT apply here. The Claw memory model: log to state/memory/YYYY-MM-DD.md as YAML-block entries (per <session-protocol>); the nightly rollup promotes to MEMORY.md. To recall something not in your loaded memory, grep state/memory/ and obsidian-vault/Claw/.`;

/**
 * Build a block re-emitting everything `buildSystemPrompt` injects at session
 * creation: persona, MEMORY.md, SESSION_PROTOCOL.md, TOOLS.md (the owner only),
 * topic memory, and the MEMORY OVERRIDE rule. Used by `buildUserPrompt` on
 * every Nth user turn so rules buried inside these files don't decay out of
 * attention. Returns null if there's nothing to inject.
 */
function buildPeriodicReminderBlock(topicConfig: TopicConfig): string | null {
  const workDir = topicConfig.workspace || WORKSPACE;
  const sections: string[] = [];

  const persona = readPersona(topicConfig.persona);
  if (persona) sections.push(`<persona-reminder>\n${persona}\n</persona-reminder>`);

  const memory = readOptional(resolve(workDir, 'MEMORY.md'));
  if (memory) sections.push(`<memory-reminder>\n${memory}\n</memory-reminder>`);

  const protocolPath = topicConfig.workspace
    ? resolve(topicConfig.workspace, 'memory/SESSION_PROTOCOL.md')
    : resolve(WORKSPACE, 'state/memory/SESSION_PROTOCOL.md');
  const protocol = readOptional(protocolPath);
  if (protocol) sections.push(`<session-protocol-reminder>\n${protocol}\n</session-protocol-reminder>`);

  // TOOLS.md is the owner-only (matches buildSystemPrompt's gate).
  if (!topicConfig.workspace) {
    const tools = readOptional(resolve(WORKSPACE, 'TOOLS.md'));
    if (tools) sections.push(`<tools-reference-reminder>\n${tools}\n</tools-reference-reminder>`);
  }

  if (topicConfig.memory) {
    const topicMem = readOptional(resolve(workDir, topicConfig.memory));
    if (topicMem) sections.push(`<topic-memory-reminder>\n${topicMem}\n</topic-memory-reminder>`);
  }

  sections.push(MEMORY_OVERRIDE_TEXT);

  if (sections.length === 0) return null;

  const lead = '[PERIODIC REMINDER — the following context blocks were injected once at session creation; re-read them before responding, since attention to once-injected content fades over long sessions.]';
  return `${lead}\n${sections.join('\n\n')}`;
}

/**
 * Build the system prompt for session CREATION only.
 * Includes persona + injected context (MEMORY.md, TOOLS.md, topic memory).
 * NOT used on resume (session already has it baked in).
 */
export function buildSystemPrompt(topicConfig: TopicConfig): string {
  const persona = readPersona(topicConfig.persona);
  const workDir = topicConfig.workspace || WORKSPACE;
  const parts = [persona];

  // Inject MEMORY.md if it exists in the workspace
  const memoryPath = resolve(workDir, 'MEMORY.md');
  const memory = readOptional(memoryPath);
  if (memory) {
    parts.push(`\n<memory>\n${memory}\n</memory>`);
  } else {
    // MEMORY.md is always expected — a missing/empty file means the session
    // starts with no long-term memory (silent before this warning).
    log.warn(`[${topicConfig.name}] MEMORY.md missing or empty at ${memoryPath} — session starts with no long-term memory`);
  }

  // Inject SESSION_PROTOCOL.md — operating procedure for daily-note writes
  const protocolPath = topicConfig.workspace
    ? resolve(topicConfig.workspace, 'memory/SESSION_PROTOCOL.md')
    : resolve(WORKSPACE, 'state/memory/SESSION_PROTOCOL.md');
  const protocol = readOptional(protocolPath);
  if (protocol) {
    parts.push(`\n<session-protocol>\n${protocol}\n</session-protocol>`);
  }

  // Inject TOOLS.md for the owner's workspace only
  if (!topicConfig.workspace) {
    const tools = readOptional(resolve(WORKSPACE, 'TOOLS.md'));
    if (tools) {
      parts.push(`\n<tools-reference>\n${tools}\n</tools-reference>`);
    }
  }

  // Topic memory — inline the contents (was a path-reference; agents skipped reading it)
  if (topicConfig.memory) {
    const topicMemPath = resolve(workDir, topicConfig.memory);
    const topicMem = readOptional(topicMemPath);
    if (topicMem) {
      parts.push(`\n<topic-memory>\n${topicMem}\n</topic-memory>`);
    } else {
      // Config declares a topic-memory file but it's missing/empty — a real
      // config/file mismatch worth surfacing (silent before this warning).
      log.warn(`[${topicConfig.name}] topic memory declared (${topicConfig.memory}) but missing or empty at ${topicMemPath}`);
    }
  }

  // Security boundary for isolated workspaces (Guest etc.)
  if (topicConfig.workspace) {
    parts.push(`\nIMPORTANT: Your workspace is ${topicConfig.workspace}. Do NOT read, write, or access any files outside this directory. You do not have access to other users' data.`);
  }

  // Memory override — the Claude Agent SDK harness injects an "auto memory" preamble
  // pointing at ~/.claude/projects/<slug>/memory/. That dir is for SDK session
  // transcripts and must NOT be used as Claw's memory. Without this override, agents
  // grep the wrong dir when recalling facts.
  // The pattern-ban (feedback_*.md etc.) was added 2026-05-10 after the same SDK preamble
  // kept tricking agents into creating per-rule files in workspace dirs (groups/friends/
  // accumulated 3 stray files; Alerts session attempted memory/feedback_no_invented_personal_details.md).
  // Text lives in MEMORY_OVERRIDE_TEXT so the periodic re-injection stays in sync.
  parts.push(`\n${MEMORY_OVERRIDE_TEXT}`);

  return parts.join('\n');
}
