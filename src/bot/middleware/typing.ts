import type { Context } from 'grammy';
import { log } from '../../util/logger.js';

/**
 * Start a typing indicator that repeats every 4 seconds.
 * Returns a stop function.
 */
export function startTyping(ctx: Context): () => void {
  let active = true;

  const threadId = ctx.message?.message_thread_id;
  const send = () => {
    if (!active) return;
    ctx.replyWithChatAction('typing', {
      ...(threadId ? { message_thread_id: threadId } : {}),
    } as any).catch(() => {});
  };

  send(); // Immediate
  const interval = setInterval(send, 4000);

  return () => {
    active = false;
    clearInterval(interval);
  };
}
