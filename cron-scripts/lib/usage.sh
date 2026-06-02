#!/usr/bin/env bash
# [IMP-COST-06] Parse the `claude -p --output-format json` envelope into (a) the
# assistant text and (b) a token/cost fragment for the cron execution log.
#
# Source AFTER lib/log.sh. Used by run-cron.sh: capture the JSON envelope once,
# extract the text for sending, and stash usage as the exec-log `extra_json`.
#
# Design goals (same as log.sh):
# - Zero behavior change on the happy path; pure parsing helpers.
# - NEVER abort the caller under `set -euo pipefail`: both helpers always
#   return 0, and on any parse failure degrade gracefully (text passes through
#   unchanged; usage fragment is empty so the exec log just omits token fields).

# usage_extract_text <raw>
#   Echo the assistant text (`.result`) from a JSON envelope. If <raw> is not
#   valid JSON or has no string `.result`, echo <raw> unchanged so a plain-text
#   reply (or a malformed envelope) is never lost.
usage_extract_text() {
  local raw="$1" out
  out="$(printf '%s' "$raw" | python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    obj = json.loads(raw)
    r = obj.get("result")
    if isinstance(r, str):
        sys.stdout.write(r)
    else:
        sys.stdout.write(raw)
except Exception:
    sys.stdout.write(raw)
' 2>/dev/null || true)"
  printf '%s' "$out"
}

# usage_extract_extra <raw> <model>
#   Echo a JSON fragment WITHOUT braces (matching log_cron_execution's extra_json
#   contract): "model":"...","cost_usd":N,"input_tokens":N,... Empty string if
#   <raw> is not a parseable result envelope (so the exec log omits token fields).
usage_extract_extra() {
  local raw="$1" model="${2:-}" out
  out="$(printf '%s' "$raw" | CLAW_USAGE_MODEL="$model" python3 -c '
import sys, os, json
raw = sys.stdin.read()
try:
    obj = json.loads(raw)
except Exception:
    sys.exit(0)
if not isinstance(obj, dict) or "result" not in obj:
    sys.exit(0)  # not a claude result envelope
u = obj.get("usage") or {}
frag = {
    "model": os.environ.get("CLAW_USAGE_MODEL") or obj.get("model") or "",
    "cost_usd": obj.get("total_cost_usd"),
    "input_tokens": u.get("input_tokens"),
    "output_tokens": u.get("output_tokens"),
    "cache_read_tokens": u.get("cache_read_input_tokens"),
    "cache_creation_tokens": u.get("cache_creation_input_tokens"),
    "num_turns": obj.get("num_turns"),
    "is_error": bool(obj.get("is_error")),
}
frag = {k: v for k, v in frag.items() if v is not None}
sys.stdout.write(json.dumps(frag)[1:-1])  # drop the outer braces
' 2>/dev/null || true)"
  printf '%s' "$out"
}
