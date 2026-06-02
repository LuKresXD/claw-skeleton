/** Strip absolute paths and session UUIDs from error messages before sending to Telegram. */
export function sanitizeError(msg: unknown): string {
  return String(msg ?? '')
    .replace(/\/root\/[^\s'")]+/g, '<path>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<session>');
}
