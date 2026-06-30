import { type Api, InputFile } from 'grammy';
import type { InputMediaPhoto } from 'grammy/types';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { TG_MAX_LENGTH, WORKSPACE } from '../config.js';
import { log } from '../util/logger.js';

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.flac', '.opus']);

export type FileKind = 'photo' | 'video' | 'audio' | 'document';

export function detectFileKind(path: string): FileKind {
  const ext = extname(path).toLowerCase();
  if (PHOTO_EXTS.has(ext)) return 'photo';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'document';
}

// @ts-ignore — no types for this package
import { telegramFormat } from 'telegram-markdown-formatter';

/** Escape raw text so it is safe to send with parse_mode HTML. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Conservative post-filter for converter output. Telegram already rejects
 * malformed HTML, but the converter input is untrusted model output, so we
 * defensively strip clearly-unsafe constructs (script/iframe/style/object/
 * embed tags and any `on*` event-handler attributes) before sending. We do
 * NOT touch the Telegram-safe allowlist (b, strong, i, em, u, s, code, pre,
 * a, blockquote, tg-spoiler) to avoid breaking valid formatting.
 */
function sanitizeTelegramHtml(html: string): string {
  return html
    // Drop dangerous element blocks entirely (open tag .. close tag).
    .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    // Drop any stray/self-closing dangerous tags left over.
    .replace(/<\/?(script|style|iframe|object|embed)\b[^>]*>/gi, '')
    // Strip inline event-handler attributes (onclick=, onerror=, …).
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Strip javascript: hrefs that Telegram would render as live links.
    .replace(/(<a\b[^>]*\bhref\s*=\s*)("|')\s*javascript:[^"']*\2/gi, '$1$2#$2');
}

/**
 * Convert Claude's markdown to Telegram HTML.
 */
export function mdToHtml(text: string): string {
  try {
    return sanitizeTelegramHtml(telegramFormat(text));
  } catch {
    // If conversion fails, send as plain text
    return escapeHtml(text);
  }
}

/**
 * Lighter-weight transform used as an intermediate fallback when Telegram
 * rejects the full HTML (400). Strips the formatting most likely to be
 * malformed — fenced/inline code and link markup — while keeping simple
 * inline emphasis, then runs the same conservative sanitizer. This recovers
 * partial formatting before the all-the-way-to-plaintext fallback.
 */
export function mdToLightHtml(text: string): string {
  try {
    let t = text
      // Remove fenced code blocks (a common source of parse failures).
      .replace(/```[\s\S]*?```/g, m => m.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
      // Strip inline code backticks but keep the content.
      .replace(/`([^`]*)`/g, '$1')
      // Reduce markdown links to just their visible text.
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    return sanitizeTelegramHtml(telegramFormat(t));
  } catch {
    return escapeHtml(text);
  }
}

/**
 * Split text into chunks that fit Telegram's 4096-char limit.
 * Prefers splitting on double newlines, then single newlines, then spaces.
 */
export function chunkText(text: string, limit = TG_MAX_LENGTH - 100): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit);
    const line = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit - 1;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);

  return chunks;
}

/** Telegram's media-group hard limit. */
const TG_ALBUM_MAX = 10;
/** Telegram's caption hard limit. */
const TG_CAPTION_MAX = 1024;
/** Directories an outbound file is allowed to come from. */
const ALLOWED_SEND_ROOTS = [WORKSPACE, '/tmp'];

/**
 * Resolve `p` and confirm it lives under an allowed root. Guards against
 * accidentally uploading arbitrary host files (e.g. a model-produced path
 * like `/etc/passwd` or a `../` traversal). Returns the resolved absolute
 * path, or null if it escapes the allowlist.
 */
function safeSendPath(p: string): string | null {
  const abs = resolve(p);
  const ok = ALLOWED_SEND_ROOTS.some(
    root => abs === root || abs.startsWith(root + '/')
  );
  return ok ? abs : null;
}

/** Clamp a caption to Telegram's limit (captions don't accept HTML here). */
function sanitizeCaption(caption?: string): string | undefined {
  if (!caption) return undefined;
  return caption.length > TG_CAPTION_MAX ? caption.slice(0, TG_CAPTION_MAX) : caption;
}

/**
 * True when a Telegram error is the "message thread not found" 400 — i.e. the
 * target topic was deleted/archived. auto-retry only handles 429/5xx, so this
 * 400 would otherwise lose the message permanently; callers fall back to the
 * plain chat (DM) instead. Matches GrammyError (error_code/description) and
 * falls back to .message for non-Grammy throwables.
 */
function isThreadNotFound(e: any): boolean {
  const desc = (e?.description ?? e?.message ?? '').toLowerCase();
  return (e?.error_code === 400 || desc.includes('bad request')) && desc.includes('thread not found');
}

/** Track active editors for graceful shutdown */
const activeEditors = new Set<ProgressiveEditor>();

export function finalizeAllEditors(): Promise<void[]> {
  return Promise.all(
    [...activeEditors].map(e => e.emergencyFinalize().catch(() => {}))
  );
}

/**
 * Manages real-time streaming via sendMessageDraft + HTML formatting.
 *
 * Flow:
 * 1. As Claude generates text, call update() with accumulated raw markdown
 * 2. sendMessageDraft streams the text to Telegram with animation
 * 3. On completion, finalize() sends the final message via sendMessage
 */
export class ProgressiveEditor {
  private api: Api;
  private chatId: string;
  private threadId: number | null;
  private replyToMsgId: number | null;
  private draftId: number;
  private lastDraftText = '';
  private lastRawText = '';
  private lastDraftAt = 0;
  private pendingDraft: NodeJS.Timeout | null = null;
  private finalized = false;
  /** Set once the target topic is found deleted (400 thread-not-found) so the
   * rest of this turn routes straight to the chat instead of re-failing. */
  private threadDead = false;
  /** Collect sent message IDs (for incognito cleanup) */
  public sentMessageIds: number[] = [];

  /**
   * Atomically claim the single terminal action (finalize / emergencyFinalize /
   * sendError) for this editor. Returns true exactly once; every later caller
   * gets false so the terminal logic can't run twice or race a shutdown-time
   * emergencyFinalize against a normal finalize. Removing from activeEditors
   * here keeps the set in sync with the flag in one step.
   */
  private claimFinalize(): boolean {
    if (this.finalized) return false;
    this.finalized = true;
    activeEditors.delete(this);
    if (this.pendingDraft) {
      clearTimeout(this.pendingDraft);
      this.pendingDraft = null;
    }
    return true;
  }

  constructor(api: Api, chatId: string, threadId: number | null, replyToMsgId?: number | null) {
    this.api = api;
    this.chatId = chatId;
    this.threadId = threadId;
    this.replyToMsgId = replyToMsgId ?? null;
    this.draftId = Math.floor(Math.random() * 2_000_000_000) + 1;
    activeEditors.add(this);
  }

  /**
   * Send an empty-text draft to surface Telegram's native "Thinking…" placeholder
   * (Bot API 10.0, May 2026). Fires once at the start of a turn before any model
   * output arrives, so the user gets instant visual feedback.
   */
  async sendInitialDraft(): Promise<void> {
    if (this.finalized || this.lastDraftAt !== 0) return;
    try {
      await this.api.raw.sendMessageDraft({
        chat_id: this.chatId,
        ...this.threadParams,
        draft_id: this.draftId,
        text: '',
      } as any);
      this.lastDraftAt = Date.now();
    } catch (e: any) {
      log.debug(`Initial draft (Thinking…) failed: ${e.message}`);
    }
  }

  private get threadParams(): Record<string, number> {
    return this.threadId && !this.threadDead ? { message_thread_id: this.threadId } : {};
  }

  /**
   * sendMessage with a one-shot DM fallback: if the target topic was deleted
   * (400 thread-not-found), flip threadDead and resend to the plain chat so the
   * message still lands. Subsequent sends this turn skip the dead thread via the
   * threadParams getter. 429/5xx are handled below us by the auto-retry plugin.
   */
  private async sendMessageWithThreadFallback(text: string, opts: Record<string, any>) {
    try {
      return await this.api.sendMessage(this.chatId, text, { ...this.threadParams, ...opts } as any);
    } catch (e: any) {
      if (this.threadId && !this.threadDead && isThreadNotFound(e)) {
        this.threadDead = true;
        log.warn(`Topic ${this.threadId} not found — routing this turn to the chat (DM fallback)`);
        return await this.api.sendMessage(this.chatId, text, { ...opts } as any);
      }
      throw e;
    }
  }

  private get replyParams(): Record<string, any> {
    return this.replyToMsgId ? { reply_to_message_id: this.replyToMsgId } : {};
  }

  /**
   * Stream accumulated text via sendMessageDraft.
   * Throttled to ~200ms to avoid hammering the API while staying smooth.
   */
  async update(rawText: string): Promise<void> {
    this.lastRawText = rawText;
    const now = Date.now();
    const elapsed = now - this.lastDraftAt;

    // Throttle: max 1 draft every 200ms
    if (elapsed < 200) {
      if (this.pendingDraft) clearTimeout(this.pendingDraft);
      this.pendingDraft = setTimeout(() => {
        this.pendingDraft = null;
        this.sendDraft(rawText);
      }, 200 - elapsed);
      return;
    }

    await this.sendDraft(rawText);
  }

  private async sendDraft(rawText: string): Promise<void> {
    // Truncate for draft display (full text sent on finalize)
    const display = rawText.length > TG_MAX_LENGTH - 200
      ? rawText.slice(0, TG_MAX_LENGTH - 200) + '\n\n...'
      : rawText;

    if (display === this.lastDraftText) return;

    try {
      await this.api.raw.sendMessageDraft({
        chat_id: this.chatId,
        ...this.threadParams,
        draft_id: this.draftId,
        text: display,
      } as any);
      this.lastDraftAt = Date.now();
      this.lastDraftText = display;
    } catch (e: any) {
      // If sendMessageDraft fails, just log — finalize will send the full message
      if (!e.message?.includes('not modified')) {
        log.debug(`Draft send failed: ${e.message}`);
      }
    }
  }

  /**
   * Emergency finalize — called on shutdown to save partial responses.
   * Sends whatever text we have as a real message so it doesn't disappear.
   * (The ephemeral draft auto-expires after 30s; we send a fresh persistent message.)
   */
  async emergencyFinalize(): Promise<void> {
    // Don't claim/mark finalized when there's nothing to save — a real
    // finalize may still arrive for this editor.
    if (this.finalized || !this.lastRawText) return;
    if (!this.claimFinalize()) return;
    const text = this.lastRawText + '\n\n⚠️ *Response interrupted (bot restarting)*';
    try {
      const html = mdToHtml(text);
      const res = await this.sendMessageWithThreadFallback(html, { parse_mode: 'HTML' });
      this.sentMessageIds.push(res.message_id);
    } catch {
      try {
        const res = await this.sendMessageWithThreadFallback(text, {});
        this.sentMessageIds.push(res.message_id);
      } catch (e: any) {
        log.debug(`emergencyFinalize: could not save partial response: ${e?.message}`);
      }
    }
  }

  /**
   * Send one chunk of formatted text with a three-tier fallback:
   * full HTML → lighter HTML transform (recovers partial formatting after a
   * 400) → escaped plain text. Returns true if any tier succeeded.
   */
  private async sendFormattedChunk(raw: string, extra: Record<string, any> = {}): Promise<boolean> {
    try {
      const res = await this.sendMessageWithThreadFallback(mdToHtml(raw), {
        ...extra,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      this.sentMessageIds.push(res.message_id);
      return true;
    } catch (e: any) {
      log.warn(`HTML send failed (${e.message}), retrying with lighter formatting`);
    }
    try {
      const res = await this.sendMessageWithThreadFallback(mdToLightHtml(raw), {
        ...extra,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      this.sentMessageIds.push(res.message_id);
      return true;
    } catch (e: any) {
      log.warn(`Light HTML send failed (${e.message}), retrying as plain text`);
    }
    try {
      const res = await this.sendMessageWithThreadFallback(raw, {
        ...extra,
        disable_web_page_preview: true,
      });
      this.sentMessageIds.push(res.message_id);
      return true;
    } catch (e2: any) {
      log.error(`Plain text send also failed: ${e2.message}`);
      return false;
    }
  }

  /**
   * Finalize: send the thinking/tool log (if any) as a persistent message, then
   * the formatted response as another. The ephemeral live draft auto-expires
   * — Bot API has no way to "promote" a draft to a real message, so we just
   * send fresh sendMessage calls. (sendMessage does NOT accept draft_id; that
   * was a misunderstanding in the previous implementation.)
   */
  async finalize(rawText: string, thinkingText?: string): Promise<void> {
    // Single-shot guard: a shutdown-time emergencyFinalize (or a duplicate
    // finalize/sendError) must not run alongside this.
    if (!this.claimFinalize()) return;

    if (thinkingText) {
      // Persist the thinking/tool log as its own message(s). Chunk first so a
      // long thinking log doesn't exceed Telegram's 4096-char limit.
      for (const chunk of chunkText(thinkingText)) {
        await this.sendFormattedChunk(chunk);
      }
    }

    // Send the formatted response
    const chunks = chunkText(rawText);

    for (let i = 0; i < chunks.length; i++) {
      const replyParam = i === 0 ? this.replyParams : {};
      await this.sendFormattedChunk(chunks[i], replyParam);
    }
  }

  /**
   * Send a group of photos as a Telegram album (media group).
   */
  async sendAlbum(photoPaths: string[], caption?: string): Promise<void> {
    // Validate each path resolves under an allowed root and exists.
    const valid: string[] = [];
    for (const p of photoPaths) {
      const safe = safeSendPath(p);
      if (!safe) {
        log.warn(`sendAlbum: refusing path outside allowed roots: ${p}`);
        continue;
      }
      if (!existsSync(safe)) continue;
      valid.push(safe);
    }
    if (valid.length === 0) {
      log.warn('sendAlbum: no valid photo paths');
      return;
    }

    const cap = sanitizeCaption(caption);

    // Telegram caps a media group at 10 items — send in batches of 10 so we
    // never silently drop photos when more were requested.
    for (let start = 0; start < valid.length; start += TG_ALBUM_MAX) {
      const batch = valid.slice(start, start + TG_ALBUM_MAX);
      const media: InputMediaPhoto[] = batch.map((p, i) => ({
        type: 'photo' as const,
        media: new InputFile(p),
        // Caption only on the very first photo of the first batch.
        ...(start === 0 && i === 0 && cap ? { caption: cap } : {}),
      }));

      try {
        const results = await this.api.sendMediaGroup(this.chatId, media, {
          ...this.threadParams,
        } as any);
        for (const r of results) this.sentMessageIds.push(r.message_id);
      } catch (e: any) {
        log.warn(`Album send failed: ${e.message}`);
      }
    }
  }

  /**
   * Send a single file. Auto-routes to sendPhoto / sendVideo / sendAudio /
   * sendDocument based on file extension.
   */
  async sendFile(path: string, caption?: string): Promise<void> {
    const safe = safeSendPath(path);
    if (!safe) {
      log.warn(`sendFile: refusing path outside allowed roots: ${path}`);
      return;
    }
    if (!existsSync(safe)) {
      log.warn(`sendFile: path not found: ${safe}`);
      return;
    }

    const file = new InputFile(safe);
    const opts: any = { ...this.threadParams };
    const cap = sanitizeCaption(caption);
    if (cap) opts.caption = cap;

    const kind = detectFileKind(safe);
    try {
      let res;
      switch (kind) {
        case 'photo': res = await this.api.sendPhoto(this.chatId, file, opts); break;
        case 'video': res = await this.api.sendVideo(this.chatId, file, opts); break;
        case 'audio': res = await this.api.sendAudio(this.chatId, file, opts); break;
        default:      res = await this.api.sendDocument(this.chatId, file, opts); break;
      }
      this.sentMessageIds.push(res.message_id);
    } catch (e: any) {
      log.warn(`sendFile (${kind}) failed for ${path}: ${e.message}`);
    }
  }

  /**
   * Send an error message. Preserves the thinking draft if any content was streamed.
   */
  async sendError(text: string): Promise<void> {
    // Single-shot guard shared with finalize/emergencyFinalize so these can't
    // race or double-send.
    if (!this.claimFinalize()) return;

    // Persist whatever thinking/tool log we had streamed so it doesn't vanish
    // with the draft (chunked so a long log stays under Telegram's limit).
    if (this.lastRawText) {
      for (const chunk of chunkText(this.lastRawText)) {
        await this.sendFormattedChunk(chunk);
      }
    }

    // Send the error as a separate message
    try {
      const res = await this.sendMessageWithThreadFallback(text, {});
      this.sentMessageIds.push(res.message_id);
    } catch (e: any) {
      log.error('Failed to send error message:', e.message);
    }
  }
}
