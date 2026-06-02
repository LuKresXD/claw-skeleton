#!/usr/bin/env bash
# Single source of truth for Claude model IDs used by Claw's cron + heartbeat
# shell scripts. Mirrors MODEL_MAP/resolveModel in src/config.ts (interactive
# bot) and DEFAULT_MODEL in scripts/memory-rollup.py (nightly rollup).
#
# WHY: the Claude CLI's built-in `opus`/`sonnet` aliases lag new model releases
# (CLI 2.1.145 still mapped `opus` to an older Opus the day 4.8 shipped). Always
# pin full model IDs here and resolve aliases through resolve_model().
# On a model upgrade, bump the three lines below and nothing else.

CLAW_OPUS_MODEL="claude-opus-4-8"
CLAW_SONNET_MODEL="claude-sonnet-4-6"
CLAW_HAIKU_MODEL="claude-haiku-4-5-20251001"

# resolve_model <alias-or-full-id> -> echoes the pinned full model id.
# Unknown values (already-full IDs) pass through unchanged.
resolve_model() {
  case "$1" in
    opus)   printf '%s' "$CLAW_OPUS_MODEL" ;;
    sonnet) printf '%s' "$CLAW_SONNET_MODEL" ;;
    haiku)  printf '%s' "$CLAW_HAIKU_MODEL" ;;
    *)      printf '%s' "$1" ;;
  esac
}
