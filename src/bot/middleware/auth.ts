import type { Context, NextFunction } from 'grammy';
import { ALLOWED_USERS, GROUP_CHATS } from '../../config.js';

/** Only allow messages from authorized users (or any user in configured group chats) */
export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  // Group chats: allow all users through (mention check happens in router)
  const chatId = String(ctx.chat?.id || '');
  if (GROUP_CHATS[chatId]) {
    await next();
    return;
  }

  if (ctx.from?.id && ALLOWED_USERS.has(ctx.from.id)) {
    await next();
  }
}
