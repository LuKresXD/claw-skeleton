import { writeFileSync, mkdirSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import type { Context, NextFunction } from 'grammy';
import { log } from '../../util/logger.js';

const MEDIA_DIR = '/tmp/claw-media';

// Bound network waits so a hung connection can't wedge the media handler (and,
// behind the per-topic queue, the whole topic). Aborts surface as AbortError,
// which the existing try/catch turns into a graceful skip.
const DOWNLOAD_TIMEOUT_MS = 30_000;   // Telegram file download
const TRANSCRIBE_TIMEOUT_MS = 60_000; // OpenAI Whisper (upload + inference)

/** Ensure media directory exists */
mkdirSync(MEDIA_DIR, { recursive: true });

/**
 * Transcribe voice/audio using OpenAI Whisper API.
 * Returns the transcribed text, or null on failure.
 */
async function transcribe(filePath: string): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn('OPENAI_API_KEY not set, skipping transcription');
    return null;
  }

  try {
    const formData = new FormData();
    // Read file as blob for FormData
    const fileBuffer = await import('node:fs/promises').then(fs => fs.readFile(filePath));
    const fileName = filePath.split('/').pop() || 'voice.ogg';
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('model', 'gpt-4o-transcribe');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.warn(`OpenAI Whisper API error (${resp.status}): ${errText}`);
      return null;
    }

    const result = await resp.json() as { text: string };
    const text = result.text?.trim();
    if (text) {
      log.info(`Transcribed voice (${text.length} chars): ${text.slice(0, 80)}...`);
    }
    return text || null;
  } catch (e: any) {
    log.warn(`Whisper transcription failed: ${e.message}`);
    return null;
  }
}

/**
 * Download photos and files to disk, transcribe voice messages.
 * Stores file paths in ctx.state.attachments and transcriptions in ctx.state.transcription.
 */
export async function mediaMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const attachments: string[] = [];
  let transcription: string | null = null;
  (ctx as any).state = (ctx as any).state || {};

  try {
    // Handle photos (Telegram sends multiple sizes, take the largest)
    if (ctx.message?.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
        const ext = file.file_path.split('.').pop() || 'jpg';
        const localPath = resolve(MEDIA_DIR, `${ctx.message.message_id}-photo.${ext}`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(localPath, buf);
        attachments.push(localPath);
        log.info(`Downloaded photo: ${localPath}`);
      }
    }

    // Handle documents
    if (ctx.message?.document) {
      const doc = ctx.message.document;
      const file = await ctx.api.getFile(doc.file_id);
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
        const name = doc.file_name || `${ctx.message.message_id}-doc`;
        const localPath = resolve(MEDIA_DIR, `${ctx.message.message_id}-${name}`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(localPath, buf);
        attachments.push(localPath);
        log.info(`Downloaded document: ${localPath}`);
      }
    }

    // Handle voice messages — download + transcribe via OpenAI
    if (ctx.message?.voice) {
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
        const localPath = resolve(MEDIA_DIR, `${ctx.message.message_id}-voice.ogg`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(localPath, buf);
        const duration = ctx.message.voice.duration || 0;
        log.info(`Downloaded voice: ${localPath} (${duration}s)`);

        transcription = await transcribe(localPath);

        if (!transcription) {
          attachments.push(localPath);
          transcription = '[Voice message — transcription failed, audio file attached]';
        }
      }
    }

    // Handle video notes (round video messages)
    if (ctx.message?.video_note) {
      const file = await ctx.api.getFile(ctx.message.video_note.file_id);
      if (file.file_path) {
        const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
        const localPath = resolve(MEDIA_DIR, `${ctx.message.message_id}-videonote.mp4`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        const buf = Buffer.from(await resp.arrayBuffer());
        writeFileSync(localPath, buf);
        attachments.push(localPath);
        log.info(`Downloaded video note: ${localPath}`);
      }
    }
  } catch (e: any) {
    log.warn('Media download failed:', e.message);
  }

  (ctx as any).state.attachments = attachments;
  (ctx as any).state.transcription = transcription;
  await next();
}
