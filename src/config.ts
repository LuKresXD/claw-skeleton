import { resolve } from 'node:path';

// --- Paths ---------------------------------------------------------------
// Root of the assistant's workspace. Everything (memory, vault, state) lives under here.
export const WORKSPACE = process.env.CLAW_WORKSPACE || resolve(process.env.HOME || process.cwd(), 'claw');
export const BOT_DIR = resolve(WORKSPACE, 'claw-bot');
export const PERSONAS_DIR = resolve(BOT_DIR, 'personas');

/** Optional second, fully-isolated user (their sessions can't see the owner's data).
 *  Leave the env vars unset / 0 to run single-user. */
export const GUEST_WORKSPACE = resolve(WORKSPACE, 'guest');

// --- Identity / access ---------------------------------------------------
// Your Telegram supergroup chat id (the bot lives in one topic-enabled supergroup).
export const CHAT_ID = process.env.CHAT_ID || '';
// Your Telegram *user* id — the only human allowed to drive the bot.
export const OWNER_USER_ID = Number(process.env.OWNER_USER_ID || '0');
// Optional second isolated user (see GUEST_WORKSPACE). 0 = disabled.
export const GUEST_USER_ID = Number(process.env.GUEST_USER_ID || '0');
export const GUEST_CHAT_ID = process.env.GUEST_CHAT_ID || '';
export const ALLOWED_USERS = new Set([OWNER_USER_ID, GUEST_USER_ID].filter(Boolean));

/** Topics handled by other services / that the bot should ignore. */
export const IGNORED_TOPICS = new Set<number>([]);

/** Heartbeat alert routing rules for a topic.
 *
 *  A heartbeat/proactive-check job can route matching inbound emails to a
 *  specific topic instead of a generic alerts topic. First match wins,
 *  evaluated in ascending `priority` order. */
export interface TopicRouteRules {
  /** Email From: addresses. Glob syntax (* matches any chars). Case-insensitive. */
  senders?: string[];
  /** Case-insensitive substrings in Email Subject. */
  subjects?: string[];
  /** Lower = higher precedence. Default 100. */
  priority?: number;
}

export interface TopicConfig {
  name: string;
  persona: string;      // filename in personas/
  memory: string | null; // path relative to WORKSPACE
  model?: string;        // override model (default: sonnet)
  workspace?: string;    // override workspace dir (default: WORKSPACE)
  reinjectEvery?: number; // override CONTEXT_REINJECT_EVERY for this topic (0 disables)
  routeRules?: TopicRouteRules; // proactive-check email routing (see TopicRouteRules)
}

// Map your Telegram topic (message_thread_id) -> config. These IDs are examples;
// replace with your own supergroup's topic ids. Each topic gets an isolated
// Claude Code session, its own persona, and its own memory file.
export const TOPICS: Record<number, TopicConfig> = {
  1000001: { name: 'General',  persona: 'default.md', memory: 'state/memory/topic-general.md' },
  1000002: { name: 'Coding',   persona: 'coding.md',  memory: 'state/memory/topic-coding.md' },
  1000003: { name: 'Coach',    persona: 'coach.md',   memory: 'state/memory/topic-coach.md' },
  1000004: { name: 'Settings', persona: 'default.md', memory: 'state/memory/topic-settings.md' },
  1000005: {
    name: 'Alerts',
    persona: 'default.md',
    memory: 'state/memory/topic-alerts.md',
    // Example routing: send school/billing mail to this topic. Use your own domains.
    routeRules: {
      priority: 60,
      senders: ['*@example.edu', 'no-reply@example.com'],
      subjects: ['Assignment', 'Grade posted', 'Invoice'],
    },
  },
};

/** Alerts topic — the fallback when no TopicConfig.routeRules matches. */
export const HEARTBEAT_DEFAULT_ALERT_TOPIC = 1000005;

// Optional second isolated user's topics (chatId GUEST_CHAT_ID) -> use their
// isolated workspace. Empty by default = single-user. Example shape:
//   820001: { name: 'Guest General', persona: 'default.md', memory: 'memory/topic-guest.md', workspace: GUEST_WORKSPACE },
export const GUEST_TOPICS: Record<number, TopicConfig> = {};

// --- Group chats (non-topic based, mention-only) -------------------------
export const FRIENDS_WORKSPACE = resolve(WORKSPACE, 'groups/friends');

export interface GroupChatConfig {
  name: string;
  chatId: string;
  persona: string;
  memory: string | null;
  model?: string;
  workspace: string;    // isolated workspace — Claude can only access this dir
}

// Group chats where the bot replies only when mentioned. Empty by default.
// Example shape:
//   '-1001234567890': { name: 'Friends', chatId: '-1001234567890', persona: 'default.md', memory: 'MEMORY.md', workspace: FRIENDS_WORKSPACE },
export const GROUP_CHATS: Record<string, GroupChatConfig> = {};

// Topic IDs for cron/heartbeat delivery (replace with your own).
export const ALERT_TOPIC = 1000005;
export const COACH_TOPIC = 1000003;
export const WARDROBE_TOPIC = 1000001;

/** Map friendly model aliases to full model IDs for the Claude CLI.
 *  CLI built-in aliases lag new releases, so we pin full IDs here. */
export const MODEL_MAP: Record<string, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

/** Resolve a model alias (or full ID) to the CLI model string */
export function resolveModel(model: string): string {
  return MODEL_MAP[model] ?? model;
}

/** Hour (local) that starts a new "day" for daily notes. Before this = previous day. */
export const DAY_BOUNDARY_HOUR = 5;

/** Max concurrent claude processes across all topics */
export const MAX_CONCURRENT = 3;

/** Timeout for chat claude -p invocations (ms) */
export const CHAT_TIMEOUT_MS = 43_200_000; // 12 hours

/** Auto-clear sessions idle longer than this (ms). Legacy — kept for compat. Smart auto-clear uses the constants below. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Smart auto-clear: minimum idle before a session is even considered for clearing. */
export const AUTO_CLEAR_EVAL_MIN_MS = 1 * 60 * 60 * 1000; // 1 hour

/** Smart auto-clear: after a "keep" verdict, suppress re-eval for this long. */
export const AUTO_CLEAR_KEEP_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

/** Smart auto-clear: force clear regardless of eval verdict beyond this idle window. */
export const AUTO_CLEAR_HARD_BACKSTOP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Smart auto-clear: model used by the task-done evaluator. */
export const AUTO_CLEAR_EVAL_MODEL = 'sonnet';

/** How often to check for stale sessions (ms) */
export const AUTO_CLEAR_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Daily checkpoint fires at this hour (local). Pick an hour you're usually asleep. */
export const CHECKPOINT_HOUR = 4;

/** Reset a session during checkpoint if it has more than this many messages. */
export const CHECKPOINT_RESET_MSG_THRESHOLD = 50;

/** Reset a session during checkpoint if it's older than this (ms). */
export const CHECKPOINT_RESET_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimum interval between Telegram message edits (ms) */
export const EDIT_THROTTLE_MS = 1500;

/** Max Telegram message length */
export const TG_MAX_LENGTH = 4096;

/** Re-inject the persistent context blocks (persona, MEMORY.md, protocol, tools,
 *  topic memory) into the user prompt every Nth user turn (1-indexed). The system
 *  prompt only carries these once at session creation; over long sessions, rules
 *  buried inside them fade from attention. Set 0 to disable. */
export const CONTEXT_REINJECT_EVERY = 6;
