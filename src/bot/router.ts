import type { Context } from 'grammy';
import { CHAT_ID, TOPICS, GUEST_TOPICS, GUEST_USER_ID, GUEST_CHAT_ID, IGNORED_TOPICS, GROUP_CHATS } from '../config.js';
import { runClaudeWithRetry } from '../claude/runner.js';
import { ProgressiveEditor } from '../telegram/sender.js';
import { startTyping } from './middleware/typing.js';
import { toolIcon } from './tool-icons.js';
import { sanitizeError } from '../util/sanitize.js';
import { trackMessage, resetTimer } from './incognito.js';
import { logMessage, getRecentHistory } from './group-history.js';
import { appendLiveFeed } from './live-feed.js';
import { log } from '../util/logger.js';

/** Bot username and ID, populated at first group message */
let botUsername: string | null = null;
let botId: number | null = null;

/** Extract <<ALBUM:caption>>...<<END_ALBUM>> blocks from text, send as photo albums, return cleaned text */
export async function extractAndSendAlbums(text: string, editor: ProgressiveEditor): Promise<string> {
  const albumRegex = /<<ALBUM(?::([^>]*))?>>\n([\s\S]*?)<<END_ALBUM>>/g;
  let cleaned = text;
  let match;
  // Collect all matches first to avoid regex state issues
  const matches: { full: string; caption?: string; paths: string[] }[] = [];
  while ((match = albumRegex.exec(text)) !== null) {
    matches.push({
      full: match[0],
      caption: match[1]?.trim() || undefined,
      paths: match[2].trim().split('\n').map(p => p.trim()).filter(Boolean),
    });
  }
  for (const m of matches) {
    await editor.sendAlbum(m.paths, m.caption);
    cleaned = cleaned.replace(m.full, '');
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

/** Extract <<FILE: /path | optional caption>> markers, send as photo/video/audio/document, return cleaned text */
export async function extractAndSendFiles(text: string, editor: ProgressiveEditor): Promise<string> {
  // Capture the whole marker body (everything between `<<FILE:` and the first
  // `>>`). [\s\S] lets the body span newlines so multi-line captions don't break
  // the match. We then split the body into path + caption ourselves, rather than
  // letting the regex do it, so a path that itself contains `|` is handled: the
  // caption delimiter is the LAST spaced ` | `, and a path with no spaced pipe
  // (e.g. `<<FILE:/a|b.png>>`) is taken verbatim with no caption.
  const fileRegex = /<<FILE:([\s\S]*?)>>/g;
  let cleaned = text;
  const matches: { full: string; path: string; caption?: string }[] = [];
  let m;
  while ((m = fileRegex.exec(text)) !== null) {
    const body = m[1];
    let path: string;
    let caption: string | undefined;
    // Split on the LAST spaced ` | ` so a `|` inside the path stays in the path.
    const delim = body.lastIndexOf(' | ');
    if (delim !== -1) {
      path = body.slice(0, delim).trim();
      caption = body.slice(delim + 3).trim() || undefined;
    } else {
      path = body.trim();
      caption = undefined;
    }
    if (!path) continue; // guard against an empty/`<<FILE:>>`-style marker
    matches.push({ full: m[0], path, caption });
  }
  for (const f of matches) {
    await editor.sendFile(f.path, f.caption);
    cleaned = cleaned.replace(f.full, '');
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

import type { GroupChatConfig } from '../config.js';
import { buildGroupSystemPrompt } from '../claude/prompt-builder.js';

/** Check if a message mentions the bot (by @username or reply to bot) */
function isBotMentioned(ctx: Context, text: string): boolean {
  // Reply to bot's own message (check by ID, not just is_bot flag)
  const replyFrom = ctx.message?.reply_to_message?.from;
  if (replyFrom?.is_bot && botId && replyFrom.id === botId) return true;

  // @username mention
  if (botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;

  // Entities-based mention check (handles bot mentions even without knowing username)
  const entities = ctx.message?.entities || ctx.message?.caption_entities || [];
  for (const e of entities) {
    if (e.type === 'mention' && botUsername) {
      const mention = (text || '').slice(e.offset, e.offset + e.length);
      if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
    }
  }

  return false;
}

/** Handle a message in a group chat: always log, only respond on mention */
async function handleGroupMessage(ctx: Context, groupConfig: GroupChatConfig): Promise<void> {
  const text = ctx.message?.text || ctx.message?.caption || '';
  const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';
  const userId = ctx.from?.id || 0;

  // Resolve bot username and ID once
  if (!botUsername || !botId) {
    try {
      const me = await ctx.api.getMe();
      botUsername = me.username || null;
      botId = me.id;
    } catch (e: any) {
      // Non-fatal, but surface it: without username/ID, mention detection breaks.
      log.warn(`[${groupConfig.name}] getMe() failed, mention detection may misfire: ${e?.message ?? e}`);
    }
  }

  // Always log the message (even if bot won't respond)
  if (text) {
    logMessage(groupConfig.chatId, userId, senderName, text);
  }

  // Also log bot's own messages? No — we only log user messages here.
  // Bot responses are logged separately after sending.

  const attachments: string[] = (ctx as any).state?.attachments || [];
  const transcription: string | null = (ctx as any).state?.transcription || null;

  let userText = text;
  if (transcription) {
    userText = `[Voice message transcription]: ${transcription}${userText ? '\n' + userText : ''}`;
  }

  // Check if bot is mentioned
  if (!isBotMentioned(ctx, text)) return;

  if (!userText && !attachments.length) return;

  // Strip the @mention from the text so Claude doesn't see it as part of the question
  if (botUsername) {
    userText = userText.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
  }

  log.info(`[${groupConfig.name}] Mentioned by ${senderName}: ${userText.slice(0, 80)}${userText.length > 80 ? '...' : ''}`);

  const msgId = ctx.message?.message_id;
  if (msgId) {
    ctx.api.setMessageReaction(groupConfig.chatId, msgId, [{ type: 'emoji', emoji: '🤔' }]).catch(() => {});
  }

  // Prepend reply context (if replying to someone other than the bot)
  const reply = ctx.message?.reply_to_message;
  if (reply && !reply.from?.is_bot) {
    const replyText = reply.text || reply.caption || '';
    if (replyText) {
      const snippet = replyText.length > 1500 ? replyText.slice(0, 1500) + '...' : replyText;
      const from = reply.from?.first_name || 'Someone';
      userText = `[Replying to ${from}: "${snippet}"]\n${userText}`;
    }
  }

  const stopTyping = startTyping(ctx);
  const editor = new ProgressiveEditor(ctx.api, groupConfig.chatId, null, msgId);
  // Instant native "Thinking…" placeholder while we wait for first stream event (Bot API 10.0+)
  editor.sendInitialDraft().catch(() => {});

  // Use a stable session key for the group (convert chat ID to a number for session manager)
  // Use absolute value of chat ID as topic key to avoid negative number issues
  const sessionKey = Math.abs(Number(groupConfig.chatId));

  // Build group-specific topic config for the runner
  const topicConfigForRunner = {
    name: groupConfig.name,
    persona: groupConfig.persona,
    memory: groupConfig.memory,
    model: groupConfig.model,
    workspace: groupConfig.workspace,
  };

  let display = '';
  let lastLen = 0;
  let pendingToolCounts = new Map<string, number>();
  let hadTextSinceLastTool = true;
  let anyToolUsed = false;
  let thinkingBuffer = '';
  let thinkingActive = false; // true while the current display ends with a 💭 line

  function flushToolCounts() {
    for (const [label, count] of pendingToolCounts) {
      display += count > 1 ? `${label} ×${count}\n` : `${label}\n`;
    }
    pendingToolCounts.clear();
  }

  function closeThinkingLine() {
    thinkingActive = false;
    thinkingBuffer = '';
  }

  try {
    // Get recent chat history for context
    const chatHistory = getRecentHistory(groupConfig.chatId, 50);

    // Build group system prompt (persona only, no history — history goes in user message so it's fresh on every resume)
    const groupSysPrompt = buildGroupSystemPrompt(groupConfig, '');

    // Prepend recent history to user message so Claude sees it on every turn (system prompt is only injected on session create, not resume)
    const historyPrefix = chatHistory ? `<recent-chat-history>\n${chatHistory}\n</recent-chat-history>\n\n` : '';
    const fullUserMessage = `${historyPrefix}[From: ${senderName}]\n${userText}`;

    const result = await runClaudeWithRetry(
      sessionKey,
      topicConfigForRunner,
      fullUserMessage,
      attachments,
      (accumulated) => {
        if (accumulated.length > lastLen) {
          closeThinkingLine();
          if (pendingToolCounts.size > 0) { flushToolCounts(); display += '\n'; }
          display += accumulated.slice(lastLen);
          lastLen = accumulated.length;
          hadTextSinceLastTool = true;
          editor.update(display).catch(() => {});
        }
      },
      (toolName, inputJson) => {
        closeThinkingLine();
        anyToolUsed = true;
        const icon = toolIcon(toolName);
        let detail = '';
        try {
          const p = typeof inputJson === 'string' ? JSON.parse(inputJson) : inputJson;
          if (p.file_path) { const parts = p.file_path.split('/'); detail = parts.slice(-2).join('/'); }
          else if (p.command) { detail = p.command.slice(0, 50); }
          else if (p.pattern) { detail = `"${p.pattern.slice(0, 30)}"`; }
          else if (p.query) { detail = `"${p.query.slice(0, 40)}"`; }
        } catch (e: any) {
          // Tool-label detail is best-effort; fall back to the tool name.
          log.debug(`[${groupConfig.name}] tool input parse failed for ${toolName}: ${e?.message ?? e}`);
        }
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
      groupSysPrompt,
      (thinkingChunk) => {
        anyToolUsed = true;
        if (pendingToolCounts.size > 0) flushToolCounts();
        if (thinkingActive) {
          // Strip the previous 💭 line and re-render with appended chunk
          display = display.replace(/💭[^\n]*\n?$/, '');
        } else if (display && !display.endsWith('\n')) {
          display += '\n';
        }
        thinkingBuffer += thinkingChunk;
        thinkingActive = true;
        const truncated = thinkingBuffer.length > 1000 ? thinkingBuffer.slice(0, 1000) + '…' : thinkingBuffer;
        // Plain text inside the draft — markdown italics render as literal underscores in drafts
        display += `💭 ${truncated.replace(/\s+/g, ' ').trim()}\n`;
        hadTextSinceLastTool = true;
        editor.update(display).catch(() => {});
      },
      true, // isGroupChat — suppresses <recent-telegram> DM injection
    );

    stopTyping();
    if (pendingToolCounts.size > 0) flushToolCounts();

    if (result.error) {
      if (msgId) ctx.api.setMessageReaction(groupConfig.chatId, msgId, [{ type: 'emoji', emoji: '👎' }]).catch(() => {});
      await editor.sendError(`⚠️ ${sanitizeError(result.error)}`);
      return;
    }

    if (result.text) {
      // Extract and send any photo albums + standalone files before finalizing text
      let finalText = await extractAndSendAlbums(result.text, editor);
      finalText = await extractAndSendFiles(finalText, editor);

      // Log bot's response to history
      logMessage(groupConfig.chatId, 0, 'Claw', finalText.slice(0, 500));

      let thinking: string | undefined;
      if (anyToolUsed) {
        thinking = display;
        if (thinking.endsWith(result.text)) thinking = thinking.slice(0, -result.text.length).trimEnd();
        if (!thinking) thinking = undefined;
      }
      await editor.finalize(finalText, thinking);
      if (msgId) ctx.api.setMessageReaction(groupConfig.chatId, msgId, [{ type: 'emoji', emoji: '👍' }]).catch(() => {});
      log.info(`[${groupConfig.name}] Response: ${finalText.length} chars`);
    } else {
      await editor.sendError('Empty response.');
    }
  } catch (err: any) {
    stopTyping();
    log.error(`[${groupConfig.name}] Router error:`, err.message);
    await editor.sendError(`⚠️ Unexpected error: ${sanitizeError(err.message)}`);
  }
}

/**
 * Main AI message router.
 *
 * Two-message pattern:
 * 1. THINKING — streams via sendMessageDraft, shows Claude's work (text + tool labels)
 * 2. RESPONSE — sent as a new HTML-formatted message when done
 */
export async function routeMessage(ctx: Context): Promise<void> {
  // --- Group chat handling ---
  const chatIdStr = String(ctx.chat?.id || '');
  const groupConfig = GROUP_CHATS[chatIdStr];
  if (groupConfig) {
    await handleGroupMessage(ctx, groupConfig);
    return;
  }

  const topicId = ctx.message?.message_thread_id;
  if (IGNORED_TOPICS.has(topicId!)) return;

  // Route to the right topic config based on user
  const isGuest = ctx.from?.id === GUEST_USER_ID;
  const chatId = isGuest ? GUEST_CHAT_ID : CHAT_ID;

  // Incognito mode: off-thread messages (no topic)
  const incognito = !topicId;
  const effectiveTopicId = topicId || 0;

  let topicConfig;
  if (incognito) {
    topicConfig = { name: 'Incognito', persona: 'incognito.md', memory: null };
  } else {
    const topicMap = isGuest ? GUEST_TOPICS : TOPICS;
    topicConfig = topicMap[topicId] ?? {
      name: isGuest ? 'Guest' : `Topic-${topicId}`,
      persona: isGuest ? 'guest.md' : 'default.md',
      memory: null,
    };
  }

  let text = ctx.message?.text || ctx.message?.caption || '';
  const originalUserText = text; // capture before reply-context / transcription prefixing
  const attachments: string[] = (ctx as any).state?.attachments || [];
  const transcription: string | null = (ctx as any).state?.transcription || null;

  // Prepend reply context
  const reply = ctx.message?.reply_to_message;
  if (reply) {
    const replyText = reply.text || reply.caption || '';
    if (replyText) {
      const snippet = replyText.length > 1500 ? replyText.slice(0, 1500) + '...' : replyText;
      const from = reply.from?.is_bot ? 'Claw' : 'the owner';
      text = `[Replying to ${from}: "${snippet}"]\n${text}`;
    }
  }

  if (transcription) {
    text = `[Voice message transcription]: ${transcription}${text ? '\n' + text : ''}`;
  }

  if (!text && !attachments.length) return;

  log.info(`[${topicConfig.name}] Message from ${isGuest ? 'Guest' : 'the owner'}: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);

  const msgId = ctx.message?.message_id;
  if (msgId) {
    ctx.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: '🤔' }]).catch(() => {});
    if (incognito) trackMessage(chatId, msgId);
  }

  // Warn when entering incognito (no topic selected)
  if (incognito && !isGuest) {
    const warn = await ctx.api.sendMessage(chatId, '⚠️ No topic selected — going to <b>incognito mode</b>. Send /clear to cancel.', { parse_mode: 'HTML' });
    trackMessage(chatId, warn.message_id);
  }

  const stopTyping = startTyping(ctx);
  const editor = new ProgressiveEditor(ctx.api, chatId, incognito ? null : topicId!, msgId);
  // Instant native "Thinking…" placeholder while we wait for first stream event (Bot API 10.0+)
  editor.sendInitialDraft().catch(() => {});

  // Build the thinking display:
  // We maintain our own string with tool labels + 💭 thinking + text injected.
  // - onDelta gives us the accumulated text (response); we diff against lastLen.
  // - onToolUse injects a tool label line.
  // - onThinking streams thinking_delta chunks; we accumulate into thinkingBuffer
  //   and re-render the trailing 💭 line in place (not append-per-chunk).
  let display = '';
  let lastLen = 0;
  let pendingToolCounts = new Map<string, number>();
  let hadTextSinceLastTool = true;
  let anyToolUsed = false;
  let thinkingBuffer = '';
  let thinkingActive = false; // true while display ends with a 💭 line we own

  function flushToolCounts() {
    for (const [label, count] of pendingToolCounts) {
      if (count > 1) {
        display += `${label} ×${count}\n`;
      } else {
        display += `${label}\n`;
      }
    }
    pendingToolCounts.clear();
  }

  function closeThinkingLine() {
    thinkingActive = false;
    thinkingBuffer = '';
  }

  try {
    const result = await runClaudeWithRetry(
      effectiveTopicId,
      topicConfig,
      text,
      attachments,
      (accumulated) => {
        if (accumulated.length > lastLen) {
          closeThinkingLine();
          // Flush any pending tool counts before adding text
          if (pendingToolCounts.size > 0) {
            flushToolCounts();
            display += '\n';
          }
          display += accumulated.slice(lastLen);
          lastLen = accumulated.length;
          hadTextSinceLastTool = true;
          editor.update(display).catch(() => {});
        }
      },
      (toolName, inputJson) => {
        closeThinkingLine();
        anyToolUsed = true;
        const icon = toolIcon(toolName);
        let detail = '';
        try {
          const p = typeof inputJson === 'string' ? JSON.parse(inputJson) : inputJson;
          if (p.file_path) {
            // Show last 2 path segments for context: "wardrobe/catalog.json"
            const parts = p.file_path.split('/');
            detail = parts.slice(-2).join('/');
          } else if (p.command) {
            detail = p.command.slice(0, 50);
          } else if (p.pattern) {
            detail = `"${p.pattern.slice(0, 30)}"`;
          } else if (p.query) {
            detail = `"${p.query.slice(0, 40)}"`;
          }
        } catch (e: any) {
          // Tool-label detail is best-effort; fall back to the tool name.
          log.debug(`[${topicConfig.name}] tool input parse failed for ${toolName}: ${e?.message ?? e}`);
        }

        const label = `${icon} ${detail || toolName}`;

        // If no text since last tool, accumulate (will collapse)
        if (!hadTextSinceLastTool) {
          pendingToolCounts.set(label, (pendingToolCounts.get(label) || 0) + 1);
        } else {
          // Flush previous, start new batch
          if (pendingToolCounts.size > 0) flushToolCounts();
          // Add a blank line before tools if display doesn't already end with newline
          if (display && !display.endsWith('\n')) display += '\n';
          pendingToolCounts.set(label, 1);
          hadTextSinceLastTool = false;
        }

        // Show a preview (flush current state)
        let preview = display;
        for (const [l, c] of pendingToolCounts) {
          preview += c > 1 ? `${l} ×${c}\n` : `${l}\n`;
        }
        editor.update(preview).catch(() => {});
      },
      undefined, // systemPromptOverride
      (thinkingChunk) => {
        anyToolUsed = true;
        if (pendingToolCounts.size > 0) flushToolCounts();
        if (thinkingActive) {
          // Strip our previous 💭 line and re-render with accumulated chunk
          display = display.replace(/💭[^\n]*\n?$/, '');
        } else if (display && !display.endsWith('\n')) {
          display += '\n';
        }
        thinkingBuffer += thinkingChunk;
        thinkingActive = true;
        const truncated = thinkingBuffer.length > 1000
          ? thinkingBuffer.slice(0, 1000) + '…'
          : thinkingBuffer;
        // Plain text in draft — markdown italics render as literal underscores in drafts
        display += `💭 ${truncated.replace(/\s+/g, ' ').trim()}\n`;
        hadTextSinceLastTool = true;
        editor.update(display).catch(() => {});
      },
    );

    stopTyping();
    if (pendingToolCounts.size > 0) flushToolCounts();

    if (result.error) {
      if (msgId) ctx.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: '👎' }]).catch(() => {});
      await editor.sendError(`⚠️ ${sanitizeError(result.error)}`);
      if (incognito) { for (const id of editor.sentMessageIds) trackMessage(chatId, id); resetTimer(chatId, ctx.api); }
      return;
    }

    if (result.text) {
      // Extract and send any photo albums + standalone files before finalizing text
      let finalText = await extractAndSendAlbums(result.text, editor);
      finalText = await extractAndSendFiles(finalText, editor);

      let thinking: string | undefined;
      if (anyToolUsed) {
        thinking = display;
        if (thinking.endsWith(result.text)) {
          thinking = thinking.slice(0, -result.text.length).trimEnd();
        }
        if (!thinking) thinking = undefined;
      }
      await editor.finalize(finalText, thinking);
      if (msgId) ctx.api.setMessageReaction(chatId, msgId, [{ type: 'emoji', emoji: '👍' }]).catch(() => {});
      log.info(`[${topicConfig.name}] Response: ${finalText.length} chars`);

      // Cross-topic live feed: the owner's DM topics only (skip Guest, incognito, missing text).
      if (!isGuest && !incognito && topicId) {
        appendLiveFeed({
          topicId,
          topicName: topicConfig.name,
          userText: transcription || originalUserText || (attachments.length ? '[attachment]' : ''),
          clawText: finalText,
        });
      }
    } else {
      await editor.sendError('Empty response.');
    }

    // Track all bot messages for incognito cleanup
    if (incognito) {
      for (const id of editor.sentMessageIds) trackMessage(chatId, id);
      resetTimer(chatId, ctx.api);
    }
  } catch (err: any) {
    stopTyping();
    log.error(`[${topicConfig.name}] Router error:`, err.message);
    await editor.sendError(`⚠️ Unexpected error: ${sanitizeError(err.message)}`);
    if (incognito) { for (const id of editor.sentMessageIds) trackMessage(chatId, id); resetTimer(chatId, ctx.api); }
  }
}
