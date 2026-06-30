#!/bin/bash
# Emits the standard per-cron context prefix to stdout.
# Sourced/called by run-cron.sh, health-daily.sh, tech-news.sh, etc. so every
# cron Claude invocation sees the same flight/calendar/focus state the bot DMs do.
#
# Usage:
#   CONTEXT="$(bash "$WORKSPACE/claw-bot/cron-scripts/lib/context-prefix.sh")"
#   PROMPT="${CONTEXT}
# ${PROMPT}"
#
# Output format (any line may be omitted if no data):
#   [Time: YYYY-MM-DD HH:MM <ABBR>]
#   [Now: ...]
#   [Soon: ...]
#   [Today: ...]
#   [Recent travel: ...]
#   [Focus: ...]
set -euo pipefail
WORKSPACE="${WORKSPACE:-$HOME/claw}"

DETECTED_TZ=$(jq -r '.tz // "America/Chicago"' "$WORKSPACE/state/context/timezone.json" 2>/dev/null || echo "America/Chicago")
echo "[Time: $(TZ="$DETECTED_TZ" date '+%Y-%m-%d %H:%M %Z')]"

# Calendar context (now/soon/today/recent_travel)
CAL_CACHE="$WORKSPACE/state/context/calendar.json"
if [ -f "$CAL_CACHE" ]; then
  jq -r '.lines[]?' "$CAL_CACHE" 2>/dev/null | head -5
fi

# Active focus (only if not expired)
FOCUS_FILE="$WORKSPACE/state/context/focus.json"
if [ -f "$FOCUS_FILE" ]; then
  node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1]));
      if (d && d.text && new Date(d.expires_at) > new Date()) console.log("[Focus: " + d.text + "]");
    } catch {}
  ' "$FOCUS_FILE"
fi
