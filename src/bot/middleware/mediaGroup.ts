import type { Context, NextFunction } from 'grammy';
import { log } from '../../util/logger.js';

const FLUSH_DELAY_MS = 600;
// Backstop: any group still pending this long after creation is force-flushed by
// the sweeper, in case its timer was cleared but never re-armed.
const MAX_GROUP_AGE_MS = 30_000;
const SWEEP_INTERVAL_MS = 30_000;

interface PendingGroup {
  attachments: string[];
  caption: string;
  ctx: Context;
  next: NextFunction;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pendingGroups = new Map<string, PendingGroup>();

// Sweeper: guarantees pendingGroups can't leak if a flush timer is ever lost.
// Unref so it never keeps the process alive on its own.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [groupId, group] of pendingGroups) {
    if (now - group.createdAt >= MAX_GROUP_AGE_MS) {
      log.warn(`Media group ${groupId}: stale (${now - group.createdAt}ms), force-flushing via sweeper`);
      clearTimeout(group.timer);
      flush(groupId);
    }
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

/**
 * Buffer Telegram album messages (same media_group_id) and merge their
 * attachments before passing a single combined context downstream.
 *
 * Grammy processes updates sequentially, so we MUST return immediately
 * to unblock the update loop — then fire next() from the timer once
 * the full album has arrived.
 */
export async function mediaGroupMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const groupId = ctx.message?.media_group_id;

  if (!groupId) {
    await next();
    return;
  }

  const myAttachments: string[] = (ctx as any).state?.attachments ?? [];
  const caption = ctx.message?.caption ?? '';

  if (!pendingGroups.has(groupId)) {
    // First message in group — save ctx + next, start timer
    pendingGroups.set(groupId, {
      attachments: [...myAttachments],
      caption,
      ctx,
      next,
      timer: setTimeout(() => flush(groupId), FLUSH_DELAY_MS),
      createdAt: Date.now(),
    });
    log.info(`Media group ${groupId}: first message, buffering...`);
  } else {
    // Subsequent message — accumulate attachments, reset timer
    const group = pendingGroups.get(groupId)!;
    group.attachments.push(...myAttachments);
    if (!group.caption && caption) group.caption = caption;

    clearTimeout(group.timer);
    group.timer = setTimeout(() => flush(groupId), FLUSH_DELAY_MS);

    log.info(`Media group ${groupId}: +${myAttachments.length}, total ${group.attachments.length}`);
  }

  // Return immediately — don't block Grammy's sequential update loop
}

/** Number of album groups currently buffering (for /status). */
export function getPendingGroupCount(): number {
  return pendingGroups.size;
}

function flush(groupId: string): void {
  const group = pendingGroups.get(groupId);
  if (!group) return;
  // Clear the timer and drop the entry up-front, inside try/finally, so the Map
  // can never leak even if merging the attachments or kicking off next() throws.
  try {
    clearTimeout(group.timer);

    // Merge all attachments into the first message's ctx
    (group.ctx as any).state.attachments = group.attachments;
    log.info(`Media group ${groupId}: flushing ${group.attachments.length} attachment(s)`);

    // Continue the middleware chain (queueMiddleware → routeMessage)
    group.next().catch((err) => {
      log.error(`Media group ${groupId} flush error:`, err);
    });
  } finally {
    pendingGroups.delete(groupId);
  }
}
