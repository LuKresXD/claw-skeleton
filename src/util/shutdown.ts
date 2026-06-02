import { log } from './logger.js';

type CleanupFn = () => Promise<void> | void;
const cleanups: CleanupFn[] = [];

export function onShutdown(fn: CleanupFn) {
  cleanups.push(fn);
}

let shutting = false;

async function shutdown(signal: string) {
  if (shutting) return;
  shutting = true;
  log.info(`Received ${signal}, shutting down...`);

  for (const fn of cleanups) {
    try {
      await fn();
    } catch (e) {
      log.error('Cleanup error:', e);
    }
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
