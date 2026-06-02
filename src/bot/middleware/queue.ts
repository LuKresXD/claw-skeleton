import type { Context, NextFunction } from 'grammy';
import { MAX_CONCURRENT, GROUP_CHATS } from '../../config.js';
import { cancelPendingAsks } from '../callbacks.js';
import { log } from '../../util/logger.js';

/**
 * Per-topic concurrency queue.
 * Only 1 Claude process per topic at a time.
 * Different topics process in parallel (up to MAX_CONCURRENT total).
 */
const topicQueues = new Map<number, Promise<void>>();

/** Global concurrency semaphore */
let activeCount = 0;
const waiters: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return Promise.resolve();
  }
  log.warn(`Global concurrency limit reached (${MAX_CONCURRENT}), queuing...`);
  return new Promise(resolve => waiters.push(resolve));
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter (activeCount stays the same)
    next();
  } else {
    activeCount--;
  }
}

/** Live concurrency snapshot for /status: active global slots, turns waiting for a slot, topics with an in-flight chain. */
export function getQueueStats(): { active: number; waiting: number; busyTopics: number } {
  return { active: activeCount, waiting: waiters.length, busyTopics: topicQueues.size };
}

export async function queueMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  // Resolve queue key: topic ID for topics, abs(chatId) for group chats, 0 for incognito
  const chatIdStr = String(ctx.chat?.id || '');
  const groupConfig = GROUP_CHATS[chatIdStr];
  const topicId = groupConfig
    ? Math.abs(Number(groupConfig.chatId))
    : (ctx.message?.message_thread_id || 0);

  // BEFORE we chain onto the queue, cancel any in-flight claw-ask for this
  // (chat, thread). The previous Claude turn is blocked in Bash polling the
  // claw-ask state file; flipping `cancelled: true` on it lets that Bash call
  // return cleanly, freeing the turn so this new message can be processed
  // immediately instead of waiting up to 30 min for a tap that won't come.
  // Must run BEFORE queue.chain.then(), since `await prev` would itself wait
  // for the blocked turn to finish.
  const askChatId = groupConfig ? groupConfig.chatId : String(ctx.chat?.id ?? '');
  const askThreadId = groupConfig ? null : (ctx.message?.message_thread_id ?? null);
  if (askChatId) {
    const n = cancelPendingAsks(askChatId, askThreadId);
    if (n) log.info(`queue: cancelled ${n} pending claw-ask(s) for chat=${askChatId} thread=${askThreadId} on incoming message`);
  }

  // Chain onto the topic's queue
  const prev = topicQueues.get(topicId) ?? Promise.resolve();

  const current = prev.then(async () => {
    await acquireSlot();
    try {
      await next();
    } finally {
      releaseSlot();
    }
  }).catch((err) => {
    log.error(`Queue error for topic ${topicId}:`, err);
  });

  topicQueues.set(topicId, current);

  // Prevent unbounded Map growth: once this chain settles, drop the entry —
  // but only if it's still the tail (no newer message chained onto it). A newer
  // message overwrites topicQueues[topicId] with its own promise, so the stale
  // === check keeps per-topic serialization intact.
  current.finally(() => {
    if (topicQueues.get(topicId) === current) {
      topicQueues.delete(topicId);
    }
  });
}
