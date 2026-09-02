#!/usr/bin/env bash
# launchd wrapper for collect-hires.mjs (weekly; plist: de.6bm.pegel-hires).
#
# The PATH export lives HERE, not in the plist: launchd hands an agent only
# /usr/bin:/bin:/usr/sbin:/sbin, and a plist edit takes effect only when the
# agent is reinstalled, while an export takes effect on the next run
# (ops/reference/machine-conventions.md, three silent outages in one summer).
#
# Heartbeat: a job that dies cannot report its own death, so a healthy run posts
# `cron:pegel-hires` onto the wall and the SessionStart recap raises the ABSENCE
# of that word past the cadence. Fail-soft — the wall is a report channel, not a
# dependency — but never silent: a rejected post is printed, not swallowed.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
LABEL=pegel-hires

command -v node >/dev/null 2>&1 || { printf 'collect-hires.sh: node not on PATH (%s)\n' "$PATH" >&2; exit 1; }

report() { # <ok|failed> <message ≤140 chars>
  local outcome="$1" msg="$2"
  command -v wallii >/dev/null 2>&1 || { printf 'collect-hires.sh: wallii not on PATH — no heartbeat for cron:%s\n' "$LABEL" >&2; return 0; }
  WALLII_ACTOR="cron:$LABEL" wallii post -t chore --outcome "$outcome" --took none "${msg:0:140}" >/dev/null \
    || printf 'collect-hires.sh: wall post for cron:%s rejected (see above)\n' "$LABEL" >&2
  return 0
}

printf '%s collect-hires start\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if out="$(node scripts/forecast/collect-hires.mjs 2>&1)"; then
  printf '%s\n' "$out"
  report ok "hires collect: ${out##*$'\n'}"
else
  printf '%s\n' "$out" >&2
  report failed "hires collect failed: ${out##*$'\n'}"
  exit 1
fi
