import { listSessions, reset } from './session-manager.js';
import { isActive } from './active-tracker.js';
import { summarizeAndSave } from '../bot/commands.js';
import {
  TOPICS, GUEST_TOPICS, GROUP_CHATS,
  CHECKPOINT_HOUR, CHECKPOINT_RESET_MSG_THRESHOLD, CHECKPOINT_RESET_AGE_MS,
} from '../config.js';
import { log } from '../util/logger.js';

/** Resolve display name for a topic/group ID */
function topicName(id: number): string {
  if (id === 0) return 'Incognito';
  const topic = TOPICS[id] || GUEST_TOPICS[id];
  if (topic) return topic.name;
  const group = Object.values(GROUP_CHATS).find(g => Math.abs(Number(g.chatId)) === id);
  if (group) return group.name;
  return `Topic-${id}`;
}

/** Milliseconds until the next CHECKPOINT_HOUR in America/Chicago. */
function msUntilNextCheckpoint(): number {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(fmt.find(p => p.type === t)!.value);
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  // Minutes past midnight CDT.
  const nowMin = hour * 60 + minute + second / 60;
  const targetMin = CHECKPOINT_HOUR * 60;
  let deltaMin = targetMin - nowMin;
  if (deltaMin <= 0) deltaMin += 24 * 60;
  return Math.round(deltaMin * 60_000);
}

/** Single sweep: summarize each active session, optionally reset oldest/busiest. */
async function runCheckpoint(): Promise<void> {
  const sessions = listSessions();
  log.info(`[checkpoint] Starting sweep of ${sessions.length} session(s)`);

  const now = Date.now();
  let processed = 0;

  for (const session of sessions) {
    const id = Number(session.topicId);

    if (session.messageCount <= 1) continue;
    if (id === 0) continue; // Incognito has its own lifecycle
    if (isActive(id)) {
      log.info(`[checkpoint] ${topicName(id)} is active, skipping`);
      continue;
    }

    const name = topicName(id);
    const age = now - session.createdAt;
    const shouldReset = session.messageCount > CHECKPOINT_RESET_MSG_THRESHOLD || age > CHECKPOINT_RESET_AGE_MS;

    try {
      await summarizeAndSave(id, name);
      processed++;
      if (shouldReset) {
        const reason = session.messageCount > CHECKPOINT_RESET_MSG_THRESHOLD
          ? `${session.messageCount} msgs`
          : `${Math.round(age / 86_400_000)}d old`;
        log.info(`[checkpoint] ${name} reset (${reason})`);
        reset(id);
      } else {
        log.info(`[checkpoint] ${name} saved (${session.messageCount} msgs)`);
      }
    } catch (e: any) {
      log.error(`[checkpoint] Failed for ${name}: ${e.message}`);
    }
  }

  log.info(`[checkpoint] Sweep done: ${processed}/${sessions.length} processed`);
}

/** Start the daily checkpoint scheduler. Call once at boot. */
export function startCheckpointScheduler(): void {
  const delay = msUntilNextCheckpoint();
  const mins = Math.round(delay / 60_000);
  log.info(`[checkpoint] Enabled — next run in ${mins} min (${CHECKPOINT_HOUR}:00 CDT)`);

  setTimeout(() => {
    runCheckpoint().catch(e => log.error('[checkpoint] Sweep error:', e.message));
    setInterval(() => {
      runCheckpoint().catch(e => log.error('[checkpoint] Sweep error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, delay);
}
