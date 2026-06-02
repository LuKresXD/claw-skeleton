import type { Api } from 'grammy';
import { log } from '../util/logger.js';
import { reset } from '../claude/session-manager.js';

const INCOGNITO_TTL = 60 * 60 * 1000; // 1 hour of inactivity
const INCOGNITO_TOPIC_ID = 0; // session-manager key for incognito

interface IncognitoState {
  messageIds: number[];
  timer: NodeJS.Timeout | null;
}

const states = new Map<string, IncognitoState>();

export function trackMessage(chatId: string, msgId: number) {
  let state = states.get(chatId);
  if (!state) {
    state = { messageIds: [], timer: null };
    states.set(chatId, state);
  }
  state.messageIds.push(msgId);
}

export function resetTimer(chatId: string, api: Api) {
  let state = states.get(chatId);
  if (!state) {
    state = { messageIds: [], timer: null };
    states.set(chatId, state);
  }
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => cleanup(chatId, api), INCOGNITO_TTL);
}

/** Manual clear — called from /clear in incognito mode */
export async function clearIncognito(chatId: string, api: Api) {
  await cleanup(chatId, api);
}

async function cleanup(chatId: string, api: Api) {
  const state = states.get(chatId);
  if (!state) return;

  log.info(`[Incognito] Cleaning up ${state.messageIds.length} messages for chat ${chatId}`);

  for (const msgId of state.messageIds) {
    try {
      await api.deleteMessage(chatId, msgId);
    } catch (e: any) {
      // Non-fatal: message may already be gone or too old to delete (>48h).
      log.debug(`[Incognito] failed to delete message ${msgId} in chat ${chatId}: ${e?.message ?? e}`);
    }
  }

  // Also reset the incognito Claude session
  reset(INCOGNITO_TOPIC_ID);

  states.delete(chatId);
}
