/**
 * Parses NDJSON stream from `claude -p --output-format stream-json`.
 *
 * Each line is a JSON object. We extract text deltas for progressive
 * Telegram editing and detect completion/errors.
 */

export interface UsageData {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface StreamCallbacks {
  onDelta(text: string): void;
  onComplete(fullText: string, sessionId: string, usage?: UsageData): void;
  onError(error: string): void;
  onToolUse?(toolName: string, inputJson: string): void;
  onThinking?(text: string): void;
}

export function parseStreamLine(line: string, callbacks: StreamCallbacks): void {
  if (!line.trim()) return;

  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // Skip non-JSON lines (e.g., debug output)
  }

  // Final result event
  if (obj.type === 'result') {
    if (obj.subtype === 'error' || obj.subtype === 'error_during_execution' || obj.is_error) {
      const errorMsg = obj.error || (Array.isArray(obj.errors) ? obj.errors.join('; ') : null) || obj.result || 'Unknown error';
      callbacks.onError(errorMsg);
    } else {
      const usage: UsageData = {
        costUsd: obj.total_cost_usd || 0,
        inputTokens: (obj.usage?.input_tokens || 0) + (obj.usage?.cache_creation_input_tokens || 0) + (obj.usage?.cache_read_input_tokens || 0),
        outputTokens: obj.usage?.output_tokens || 0,
      };
      callbacks.onComplete(obj.result || '', obj.session_id || '', usage);
    }
    return;
  }

  // Assistant message with content (complete message — arrives after all deltas).
  // We only pull tool_use from here because tool inputs stream as raw JSON chunks
  // (input_json_delta) which are useless until complete. Text and thinking already
  // streamed via deltas below, so don't re-emit them.
  if (obj.type === 'assistant' && obj.message?.content) {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && callbacks.onToolUse) {
          callbacks.onToolUse(block.name, JSON.stringify(block.input ?? {}));
        }
      }
    }
    return;
  }

  // Streaming content delta (text + thinking, with --include-partial-messages)
  if (obj.type === 'content_block_delta' || obj.type === 'stream_event') {
    const delta = obj.delta ?? obj.event?.delta;
    if (delta?.type === 'text_delta' && delta.text) {
      callbacks.onDelta(delta.text);
    } else if (delta?.type === 'thinking_delta' && delta.thinking && callbacks.onThinking) {
      callbacks.onThinking(delta.thinking);
    }
    // signature_delta + input_json_delta are intentionally ignored
    return;
  }

  // Partial message with text content (from --include-partial-messages)
  if (obj.type === 'assistant' && typeof obj.message === 'string') {
    callbacks.onDelta(obj.message);
    return;
  }
}
