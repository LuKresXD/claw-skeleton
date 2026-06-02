#!/usr/bin/env bash
# Telegram failure notifier. Wired via systemd OnFailure=claw-notify@%n.service.
# Posts to the Alerts topic when any claw cron/service enters failed state.
# Audit WS-2 (self-maintenance/observability): closes the "30 services with no
# OnFailure alerting -> silent failures" gap. Arg $1 = failing unit name (%n).
set -uo pipefail

UNIT="${1:-unknown.service}"
# %n is already the literal unit name (dashes are literal, not escaped slashes).
# Do NOT run systemd-escape -u on it - that mangles claw-cron-x.service into claw/cron/x.service.

ENV_FILE=/root/.openclaw/workspace/claw-bot/.env
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
TOKEN="${BOT_TOKEN:-}"
CHAT="${CHAT_ID:-}"
TOPICS_LIB=/root/.openclaw/workspace/claw-bot/cron-scripts/lib/topics.sh
if [ -f "$TOPICS_LIB" ]; then . "$TOPICS_LIB"; fi
ALERTS_TOPIC="${CLAW_ALERTS_TOPIC:-1000005}"
[ -z "$TOKEN" ] && { echo "notify-failure: no BOT_TOKEN, abort" >&2; exit 0; }

TS="$(date '+%Y-%m-%d %H:%M %Z')"
# Last result + a few journal lines for context, HTML-sanitized.
RESULT="$(systemctl show "$UNIT" -p Result --value 2>/dev/null)"
LOG="$(journalctl -u "$UNIT" -n 10 --no-pager -o cat 2>/dev/null | tail -10 | tr -d '\000' | sed 's/[<>&]//g' | head -c 1100)"

TEXT="$(printf '%s' "⚠️ <b>Cron failure</b>
<code>${UNIT}</code> (result: ${RESULT:-unknown}) at ${TS}

<b>Last log:</b>
<pre>${LOG}</pre>")"

curl -s --max-time 20 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "message_thread_id=${ALERTS_TOPIC}" \
  --data-urlencode "text=${TEXT}" \
  -d "parse_mode=HTML" -d "disable_web_page_preview=true" >/dev/null 2>&1 \
  && echo "notify-failure: alerted for ${UNIT}" \
  || echo "notify-failure: send failed for ${UNIT}" >&2
exit 0
