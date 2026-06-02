/** Emoji shown next to each tool name in the streaming progress display. */
export const TOOL_ICONS: Record<string, string> = {
  Read: '📖', Write: '✏️', Edit: '✏️', Bash: '⚙️',
  Glob: '🔍', Grep: '🔍', WebSearch: '🌐', WebFetch: '🌐',
};

/** Icon for a tool name, with a generic fallback for unmapped tools. */
export function toolIcon(name: string): string {
  return TOOL_ICONS[name] || '🔧';
}
