#!/usr/bin/env bash
# Shared logging helpers for Claw cron + heartbeat shell scripts.
# [IMP-CRON-04] Additive: consistent, timestamped log lines to stdout/stderr
# (which systemd captures to the journal) + an append-only cron execution log.
#
# Source this file AFTER setting WORKSPACE (defaults to the standard path):
#   source "$WORKSPACE/claw-bot/cron-scripts/lib/log.sh"
#
# Design goals:
# - Zero behavior change: helpers only WRITE logs, never alter exit codes or output.
# - Safe under `set -euo pipefail`: every helper is self-contained and tolerant of
#   missing files / unset optional args; nothing here should ever abort a caller.
# - No secrets: callers pass plain status strings, never token values.

# Resolve workspace if the caller didn't set it.
: "${CLAW_LOG_WORKSPACE:=${WORKSPACE:-/root/.openclaw/workspace}}"

# Append-only cron execution log (one JSON object per run). Rotated by
# rotate_cron_executions() to keep ~90 days. See [IMP-OBS-03].
: "${CLAW_CRON_EXEC_LOG:=$CLAW_LOG_WORKSPACE/state/bot-state/cron-executions.jsonl}"

# ---------------------------------------------------------------------------
# Console logging (-> journal via systemd). All go to stderr by default so they
# never contaminate a script's captured stdout (e.g. RESULT=$(...)).
# ---------------------------------------------------------------------------

# _claw_log_ts -> ISO-8601 local timestamp.
_claw_log_ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

# log_info <msg...>
log_info() { printf '[%s] %s\n' "$(_claw_log_ts)" "$*" >&2; }

# log_warn <msg...>
log_warn() { printf '[%s] WARN: %s\n' "$(_claw_log_ts)" "$*" >&2; }

# log_error <msg...>
log_error() { printf '[%s] ERROR: %s\n' "$(_claw_log_ts)" "$*" >&2; }

# ---------------------------------------------------------------------------
# Cron execution log [IMP-OBS-03]
# Append one status line per run: job name, start, end, exit code, duration.
# Append-only JSONL. Never throws; failures to write are swallowed (a logging
# helper must not break the job it instruments).
# ---------------------------------------------------------------------------

# now_ms -> current epoch milliseconds (used to bracket a run for duration).
now_ms() { date +%s%3N; }

# log_cron_execution <job> <start_ms> <end_ms> <exit_code> [extra_json]
#   job        : short job name (e.g. "ideas", "heartbeat", "health-daily")
#   start_ms   : epoch ms captured at job start (from now_ms)
#   end_ms     : epoch ms captured at job end (from now_ms)
#   exit_code  : the job's exit code (integer)
#   extra_json : OPTIONAL extra fields as a JSON fragment WITHOUT braces,
#                e.g. 'topic":"1000005","model":"opus' (advanced; usually omit)
# Writes one line like:
#   {"job":"ideas","start":"<iso>","end":"<iso>","start_ms":...,"end_ms":...,
#    "duration_ms":...,"exit_code":0,"host":"..."}
log_cron_execution() {
  local job="${1:-unknown}" start_ms="${2:-0}" end_ms="${3:-0}" exit_code="${4:-0}" extra="${5:-}"
  local logfile="$CLAW_CRON_EXEC_LOG"
  mkdir -p "$(dirname "$logfile")" 2>/dev/null || return 0
  # Compute duration defensively (handle missing/garbled inputs).
  local dur=0
  if [[ "$start_ms" =~ ^[0-9]+$ && "$end_ms" =~ ^[0-9]+$ ]]; then
    dur=$(( end_ms - start_ms ))
    [ "$dur" -lt 0 ] && dur=0
  fi
  # Build via python3 for correct JSON escaping of the job name; fall back to a
  # minimal printf if python3 is somehow unavailable.
  local line
  line=$(python3 - "$job" "$start_ms" "$end_ms" "$dur" "$exit_code" "$extra" <<'PY' 2>/dev/null
import json, sys, datetime
job, start_ms, end_ms, dur, code, extra = sys.argv[1:7]
def iso(ms):
    try:
        return datetime.datetime.fromtimestamp(int(ms)/1000).astimezone().isoformat(timespec="seconds")
    except Exception:
        return None
obj = {
    "job": job,
    "start": iso(start_ms),
    "end": iso(end_ms),
    "start_ms": int(start_ms) if start_ms.isdigit() else None,
    "end_ms": int(end_ms) if end_ms.isdigit() else None,
    "duration_ms": int(dur) if str(dur).isdigit() else None,
    "exit_code": int(code) if str(code).lstrip("-").isdigit() else code,
}
frag = json.dumps(obj)[1:-1]  # drop the outer braces
if extra:
    frag = frag + "," + extra
print("{" + frag + "}")
PY
)
  if [ -z "$line" ]; then
    # Fallback: no python3. Minimal, still valid-ish JSON (job not escaped, but
    # job names here are known-safe slugs).
    line="{\"job\":\"$job\",\"start_ms\":$start_ms,\"end_ms\":$end_ms,\"duration_ms\":$dur,\"exit_code\":$exit_code}"
  fi
  printf '%s\n' "$line" >> "$logfile" 2>/dev/null || true
}

# rotate_cron_executions [days]
# Keep only entries from the last <days> (default 90). Best-effort, atomic,
# never throws. Cheap enough to call once per run (the file is one line/run).
rotate_cron_executions() {
  local days="${1:-90}"
  local logfile="$CLAW_CRON_EXEC_LOG"
  [ -f "$logfile" ] || return 0
  python3 - "$logfile" "$days" <<'PY' 2>/dev/null || true
import json, sys, os, time, datetime
path, days = sys.argv[1], int(sys.argv[2])
cutoff = time.time() - days*86400
kept = []
try:
    with open(path) as fh:
        for line in fh:
            s = line.strip()
            if not s:
                continue
            keep = True
            try:
                obj = json.loads(s)
                ts = obj.get("start_ms") or obj.get("end_ms")
                if ts:
                    keep = (ts/1000) >= cutoff
                else:
                    iso = obj.get("start") or obj.get("end")
                    if iso:
                        dt = datetime.datetime.fromisoformat(iso)
                        keep = dt.timestamp() >= cutoff
            except Exception:
                keep = True  # never drop unparseable lines
            if keep:
                kept.append(s)
except FileNotFoundError:
    sys.exit(0)
tmp = path + ".tmp.%d" % os.getpid()
with open(tmp, "w") as fh:
    fh.write("\n".join(kept) + ("\n" if kept else ""))
os.replace(tmp, path)
PY
}
