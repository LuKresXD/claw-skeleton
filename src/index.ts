import 'dotenv/config';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { stream, type StreamFlavor } from '@grammyjs/stream';
import type { Context } from 'grammy';
import { log } from './util/logger.js';
import { onShutdown } from './util/shutdown.js';
import { loadSessions, getSession } from './claude/session-manager.js';
import { killAll, markShuttingDown, runClaudeWithRetry } from './claude/runner.js';
import { finalizeAllEditors, ProgressiveEditor, mdToHtml } from './telegram/sender.js';
import { getInterrupted } from './claude/active-tracker.js';
import { startAutoClear } from './claude/auto-clear.js';
import { startCheckpointScheduler } from './claude/checkpoint.js';
import { TOPICS, GUEST_TOPICS, GROUP_CHATS } from './config.js';
import { authMiddleware } from './bot/middleware/auth.js';
import { queueMiddleware } from './bot/middleware/queue.js';
import { mediaMiddleware } from './bot/middleware/media.js';
import { mediaGroupMiddleware } from './bot/middleware/mediaGroup.js';
import { routeMessage } from './bot/router.js';
import { registerGuestHandler } from './bot/guest.js';
import { toolIcon } from './bot/tool-icons.js';
import { sanitizeError } from './util/sanitize.js';
import {
  clearCommand,
  stopCommand,
  statusCommand,
  modelCommand,
  effortCommand,
  compactCommand,
  cronCommand,
  taskCommand,
  ideaCommand,
  statsCommand,
  helpCommand,
} from './bot/commands.js';

export type MyContext = StreamFlavor<Context>;

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN is required in .env');
  process.exit(1);
}

// Load existing sessions from disk
loadSessions();

// Daily 4am CDT checkpoint: flush memories for long-running chatty topics
startCheckpointScheduler();

const bot = new Bot<MyContext>(token);

// Start smart auto-clear (per-session task-done eval + 7d hard backstop).
// Passes bot.api so the sweeper can post 🧹 notices to the topic on clear.
startAutoClear(bot.api);

// Auto-retry on Telegram 429 rate limits (respects retry_after) — bounded so a
// pathological retry_after can't hang a topic's queue indefinitely.
bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 60 }));

// Stream plugin — adds ctx.replyWithStream()
bot.use(stream());

// Guest mode (Bot API 5.0): handle @mentions from chats where bot is not a member.
// Must run BEFORE authMiddleware — guest_message has its own caller field.
registerGuestHandler(bot);

// Middleware chain (order matters)
bot.use(authMiddleware);        // 1. Auth: only the owner
bot.use(mediaMiddleware);       // 2. Media: download photos/files

// Commands (handled before AI routing, instant response)
bot.command('clear', clearCommand);
bot.command('reset', clearCommand);
bot.command('stop', stopCommand);
bot.command('status', statusCommand);
bot.command('model', modelCommand);
bot.command('effort', effortCommand);
bot.command('compact', compactCommand);
bot.command('cron', cronCommand);
bot.command('task', taskCommand);
bot.command('todo', taskCommand);
bot.command('idea', ideaCommand);
bot.command('stats', statsCommand);
bot.command('help', helpCommand);
bot.command('start', helpCommand);

// AI message routing (with per-topic queue)
bot.on('message', mediaGroupMiddleware, queueMiddleware, routeMessage);

// Global error handler — prevents crashes
bot.catch((err) => {
  log.error('Unhandled bot error:', err.message || err);
});

// Clean /tmp/claw-media every hour (remove files older than 24h)
setInterval(() => {
  try {
    const dir = '/tmp/claw-media';
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch (e: any) {
    log.debug(`/tmp/claw-media cleanup failed: ${e?.message}`);
  }
}, 60 * 60 * 1000);

// Graceful shutdown
onShutdown(async () => {
  log.info('Stopping bot...');
  markShuttingDown(); // Prevent child close handlers from wiping active-topics.json
  await finalizeAllEditors(); // Save partial responses before dying
  await bot.stop();
  killAll();
});

// Launch
log.info('Starting Claw v2...');
bot.start({
  onStart: async () => {
    log.info('Bot is running. Waiting for messages...');
    // Notify a topic on startup
    try {
      await bot.api.sendMessage(process.env.CHAT_ID || '', '🔄 Claw v2 restarted.', {
        message_thread_id: 1000001, // a topic id of your choice
      } as any);
    } catch (e: any) {
      log.warn(`Startup restart notification failed: ${e?.message}`);
    }

    // Auto-resume interrupted topics (with full streaming like normal messages)
    const interrupted = getInterrupted();
    log.info(`Auto-resume: found ${interrupted.length} interrupted topic(s)`);
    for (const entry of interrupted) {
      const session = getSession(entry.topicId);
      if (!session || session.messageCount === 0) {
        log.info(`Auto-resume: skipping ${entry.topicName} — no session history`);
        continue;
      }

      // Look up topic config from all sources (topics, guest, groups)
      const topicConfig = TOPICS[entry.topicId] || GUEST_TOPICS[entry.topicId];
      // Also check group chats (keyed by abs chat ID)
      const groupConfig = !topicConfig
        ? Object.values(GROUP_CHATS).find(g => Math.abs(Number(g.chatId)) === entry.topicId)
        : null;
      const effectiveConfig = topicConfig || (groupConfig ? {
        name: groupConfig.name,
        persona: groupConfig.persona,
        memory: groupConfig.memory,
        model: groupConfig.model,
        workspace: groupConfig.workspace,
      } : null);

      if (!effectiveConfig) {
        log.info(`Auto-resume: skipping ${entry.topicName} — topic not in config`);
        continue;
      }

      log.info(`Auto-resuming interrupted topic: ${entry.topicName}`);

      // Notify user that resume is happening
      try {
        const promptHint = entry.lastPrompt
          ? `\n_Resuming: ${entry.lastPrompt.slice(0, 100)}${entry.lastPrompt.length > 100 ? '...' : ''}_`
          : '';
        await bot.api.sendMessage(entry.chatId, `🔄 Restarted — continuing where I left off...${promptHint}`, {
          ...(entry.threadId ? { message_thread_id: entry.threadId } : {}),
          parse_mode: 'Markdown',
        } as any);
      } catch (e: any) {
        log.warn(`Auto-resume notification failed for ${entry.topicName}: ${e?.message}`);
      }

      const editor = new ProgressiveEditor(bot.api, entry.chatId, entry.threadId);

      // Build resume prompt with context about what was being done
      const resumePrompt = entry.lastPrompt
        ? `The bot just restarted (likely because you applied a code fix). Your last task was: "${entry.lastPrompt.slice(0, 300)}". Continue from where you left off — check if your changes were applied successfully and report back.`
        : 'The bot just restarted (likely because you applied a code fix). Continue from where you left off — check if your changes were applied successfully and report back.';

      // Full streaming with tool display (mirrors router.ts behavior)
      let display = '';
      let lastLen = 0;
      let pendingToolCounts = new Map<string, number>();
      let hadTextSinceLastTool = true;
      let anyToolUsed = false;

      function flushToolCounts() {
        for (const [label, count] of pendingToolCounts) {
          display += count > 1 ? `${label} ×${count}\n` : `${label}\n`;
        }
        pendingToolCounts.clear();
      }

      try {
        const result = await runClaudeWithRetry(
          entry.topicId,
          effectiveConfig,
          resumePrompt,
          [],
          (accumulated) => {
            if (accumulated.length > lastLen) {
              if (pendingToolCounts.size > 0) { flushToolCounts(); display += '\n'; }
              display += accumulated.slice(lastLen);
              lastLen = accumulated.length;
              hadTextSinceLastTool = true;
              editor.update(display).catch(() => {});
            }
          },
          (toolName, inputJson) => {
            anyToolUsed = true;
            const icon = toolIcon(toolName);
            let detail = '';
            try {
              const p = typeof inputJson === 'string' ? JSON.parse(inputJson) : inputJson;
              if (p.file_path) { const parts = p.file_path.split('/'); detail = parts.slice(-2).join('/'); }
              else if (p.command) { detail = p.command.slice(0, 50); }
              else if (p.pattern) { detail = `"${p.pattern.slice(0, 30)}"`; }
              else if (p.query) { detail = `"${p.query.slice(0, 40)}"`; }
            } catch {}
            const label = `${icon} ${detail || toolName}`;
            if (!hadTextSinceLastTool) {
              pendingToolCounts.set(label, (pendingToolCounts.get(label) || 0) + 1);
            } else {
              if (pendingToolCounts.size > 0) flushToolCounts();
              if (display && !display.endsWith('\n')) display += '\n';
              pendingToolCounts.set(label, 1);
              hadTextSinceLastTool = false;
            }
            let preview = display;
            for (const [l, c] of pendingToolCounts) {
              preview += c > 1 ? `${l} ×${c}\n` : `${l}\n`;
            }
            editor.update(preview).catch(() => {});
          },
        );

        if (pendingToolCounts.size > 0) flushToolCounts();

        if (result.error) {
          await editor.sendError(`⚠️ Auto-resume failed: ${sanitizeError(result.error)}`);
          log.error(`Auto-resume error for ${entry.topicName}: ${result.error}`);
          continue;
        }

        if (result.text) {
          const finalText = result.text;
          let thinking: string | undefined;
          if (anyToolUsed) {
            thinking = display;
            if (thinking.endsWith(result.text)) thinking = thinking.slice(0, -result.text.length).trimEnd();
            if (!thinking) thinking = undefined;
          }
          await editor.finalize(finalText, thinking);
          log.info(`Auto-resumed ${entry.topicName}: ${finalText.length} chars`);
        }
      } catch (err: any) {
        log.error(`Auto-resume failed for ${entry.topicName}:`, err.message);
        await editor.sendError(`⚠️ Auto-resume failed: ${sanitizeError(err.message)}`).catch(() => {});
      }
    }
  },
  drop_pending_updates: true,
});
