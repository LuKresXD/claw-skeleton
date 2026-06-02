#!/bin/bash
# Shared cron job runner for Claw v2.
# Usage: run-cron.sh <topic_id> <prompt_file> [timeout_seconds]
#
# Runs claude -p with the given prompt, captures output, sends to Telegram topic.
set -euo pipefail

WORKSPACE="/root/.openclaw/workspace"
set -a
source "$WORKSPACE/claw-bot/.env"
set +a
export GIT_AUTHOR_NAME=claw-bot GIT_AUTHOR_EMAIL=noreply@claw.local GIT_COMMITTER_NAME=claw-bot GIT_COMMITTER_EMAIL=noreply@claw.local

# [IMP-OBS-03] Cron execution log (additive instrumentation — never alters
# behavior or exit codes). An EXIT trap records one JSONL line per run with the
# real exit code, whether the job succeeded, failed, or hit the timeout.
source "$WORKSPACE/claw-bot/cron-scripts/lib/log.sh"
CRON_EXEC_START_MS=$(now_ms)
CRON_EXEC_JOB="cron"   # refined to the prompt's basename once $2 is known below
CRON_EXEC_EXTRA=""     # [IMP-COST-06] token/cost JSON fragment, filled post-claude
_log_cron_exit() {
  local code=$?
  log_cron_execution "$CRON_EXEC_JOB" "$CRON_EXEC_START_MS" "$(now_ms)" "$code" "$CRON_EXEC_EXTRA"
  rotate_cron_executions 90
  return 0  # never change the exit code
}
trap _log_cron_exit EXIT

# Usage: run-cron.sh <topic_id> <prompt_file> [timeout_seconds] [model] [effort]
TOPIC_ID="$1"

# Deliver to the owner's chat (CHAT_ID comes from .env). For a second isolated
# user, add a case here mapping their topic ids to their chat id.
CHAT_ID="${CHAT_ID:-}"
PROMPT_FILE="$2"
CRON_EXEC_JOB="$(basename "$PROMPT_FILE" .txt)"   # [IMP-OBS-03] refine exec-log job name
TIMEOUT="${3:-120}"
MODEL="${4:-sonnet}"
EFFORT="${5:-}"

# Resolve friendly aliases (opus/sonnet/haiku) to pinned full model IDs.
# CLI built-in aliases lag new releases — see cron-scripts/lib/models.sh.
source "$WORKSPACE/claw-bot/cron-scripts/lib/models.sh"
source "$WORKSPACE/claw-bot/cron-scripts/lib/topics.sh"
source "$WORKSPACE/claw-bot/cron-scripts/lib/usage.sh"   # [IMP-COST-06] token/cost parsing
MODEL="$(resolve_model "$MODEL")"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

PROMPT="$(cat "$PROMPT_FILE")"

# Per-cron context prefix: the full shared context (time / calendar / focus) from
# cron-scripts/lib/context-prefix.sh — same source of truth as the bot's
# per-message injection.
CONTEXT_PREFIX=$(bash "$WORKSPACE/claw-bot/cron-scripts/lib/context-prefix.sh")

PROMPT="${CONTEXT_PREFIX}
$PROMPT"

echo "[$(date -Iseconds)] Running cron: $(basename "$PROMPT_FILE" .txt) → topic $TOPIC_ID"

# Run Claude headless (no session persistence — fresh each time)
EFFORT_FLAG=""
[ -n "$EFFORT" ] && EFFORT_FLAG="--effort $EFFORT"

# Run in the owner's workspace, with explicit access to the vault + /tmp
# (Claude Code sandboxes nested .git boundaries even inside cwd).
CRON_WORKDIR="$WORKSPACE"
EXTRA_DIRS=(--add-dir "$WORKSPACE/obsidian-vault" --add-dir /tmp)
# Pre-pull vault so Claude reads latest. Bash sandbox forbids it from claude.
(cd "$WORKSPACE/obsidian-vault" && git pull --quiet) > /dev/null 2>&1 || true

RESULT=$(cd "$CRON_WORKDIR" && CLAW_CHAT_ID="$CHAT_ID" timeout "${TIMEOUT}s" /root/.local/bin/claude -p "$PROMPT" \
  --model "$MODEL" \
  $EFFORT_FLAG \
  --no-session-persistence \
  --output-format json \
  --permission-mode acceptEdits \
  --add-dir "$CRON_WORKDIR" \
  "${EXTRA_DIRS[@]}" \
  2>/dev/null) || {
  CODE=$?
  MSG="⚠️ Cron job $(basename "$PROMPT_FILE" .txt) failed (exit $CODE)"
  echo "$MSG" >&2
  # Send failure notification to Alerts topic
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d message_thread_id="${CLAW_ALERTS_TOPIC:-1000005}" \
    --data-urlencode "text=$MSG" > /dev/null
  exit $CODE
}

# [IMP-COST-06] The call now returns a JSON envelope. Stash token/cost for the
# exec-log EXIT trap, then reduce RESULT to just the assistant text so the
# existing album/markdown/send path is unchanged. Both helpers degrade
# gracefully (text passes through, usage omitted) if the output isn't JSON.
CRON_EXEC_EXTRA="$(usage_extract_extra "$RESULT" "$MODEL")"
RESULT="$(usage_extract_text "$RESULT")"

# [IMP-COST-06] Dry-run: exercise capture/extract/log with no Telegram send or
# git commit. `CLAW_CRON_DRYRUN=1 run-cron.sh ...` for safe testing.
if [ -n "${CLAW_CRON_DRYRUN:-}" ]; then
  echo "[DRYRUN] job=$CRON_EXEC_JOB model=$MODEL result_chars=${#RESULT}"
  echo "[DRYRUN] exec-log extra: {$CRON_EXEC_EXTRA}"
  exit 0
fi

# Auto-commit any vault changes Claude wrote (the owner's crons only — Guest has no vault).
# Claude Code sandbox forbids bash from operating inside nested git repos, so we do
# the commit/push outside the claude invocation.
CRON_NAME=$(basename "$PROMPT_FILE" .txt)
if [ "$CRON_WORKDIR" = "$WORKSPACE" ] && [ -d "$WORKSPACE/obsidian-vault/.git" ]; then
  (cd "$WORKSPACE/obsidian-vault" && git add -A && \
    git diff --cached --quiet || \
    (git commit -m "Claw: $CRON_NAME $(date +%Y-%m-%d)" && git push)) > /dev/null 2>&1 || \
    echo "vault auto-commit failed (non-fatal)" >&2
fi

# Per-cron state/ auto-commit (scoped allowlist — same nested-repo sandbox issue).
# Only crons whose name appears here may commit MEMORY.md / topic-*.md changes.
# Daily notes (state/memory/YYYY-MM-DD.md) are intentionally NEVER auto-committed —
# the bot writes them constantly and they're expected to stay dirty.
case "$CRON_NAME" in
  memory-drift-audit)
    if [ -d "$WORKSPACE/state/.git" ]; then
      (cd "$WORKSPACE/state" && \
        git add memory/MEMORY.md "memory/topic-"*.md 2>/dev/null; \
        git diff --cached --quiet || \
        (git commit -m "Claw: $CRON_NAME $(date +%Y-%m-%d)" && git push)) > /dev/null 2>&1 || \
        echo "state auto-commit failed (non-fatal)" >&2
    fi
    ;;
esac

# Extract and send any <<ALBUM>> photo blocks before text conversion
RESULT=$(echo "$RESULT" | node "$WORKSPACE/claw-bot/cron-scripts/send-albums.mjs" "$CHAT_ID" "$TOPIC_ID")

# Convert markdown to Telegram HTML
RESULT=$(echo "$RESULT" | node "$WORKSPACE/claw-bot/cron-scripts/md-to-html.mjs")

# Skip sending if output is empty or just whitespace
if [ -z "$(echo "$RESULT" | tr -d '[:space:]')" ]; then
  echo "Empty output, skipping send"
  exit 0
fi

# Send to Telegram (split if over 4000 chars for safety margin)
send_chunk() {
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d chat_id="$CHAT_ID" \
    -d message_thread_id="$1" \
    -d parse_mode="HTML" \
    --data-urlencode "text=$2" \
    -d disable_web_page_preview=true > /dev/null
}

while [ ${#RESULT} -gt 4000 ]; do
  send_chunk "$TOPIC_ID" "${RESULT:0:4000}"
  RESULT="${RESULT:4000}"
  sleep 0.5
done
[ -n "$RESULT" ] && send_chunk "$TOPIC_ID" "$RESULT"

echo "Done, sent to topic $TOPIC_ID"
