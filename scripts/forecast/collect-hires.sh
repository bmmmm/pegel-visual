#!/usr/bin/env bash
# launchd wrapper for collect-hires.mjs (weekly; plist: de.6bm.pegel-hires).
#
# Two steps: collect into tmp-forecast/hires/ (the loader's source), then mirror
# that directory into the `hires` data branch on GitHub, so sixteen weeks of
# 15-minute readings do not live on one laptop only. Like the `archive` branch
# the mirror is GitHub-only (origin is the Forgejo CODE mirror and never carries
# a data branch — a stale copy there is what enabled the 2026-08-23 force-push
# reset) and protected against force-push and deletion; this job only ever
# fast-forwards it. The mirror is a superset: nothing is deleted from the
# branch when a local file goes missing (no --delete).
#
# The PATH export lives HERE, not in the plist: launchd hands an agent only
# /usr/bin:/bin:/usr/sbin:/sbin, and a plist edit takes effect only when the
# agent is reinstalled, while an export takes effect on the next run
# (ops/reference/machine-conventions.md, three silent outages in one summer).
#
# Heartbeat: a job that dies cannot report its own death, so a healthy run posts
# `cron:pegel-hires` onto the wall and the SessionStart recap raises the ABSENCE
# of that word past the cadence (dotfiles session-recap.sh roster, 192 h).
# Fail-soft — the wall is a report channel, not a dependency — but never silent:
# a rejected post is printed, not swallowed. Collected but not mirrored is
# `partial`, so a broken push is visible without hiding that the data is safe
# on disk.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
LABEL=pegel-hires
DATA="$REPO/tmp-forecast/hires"
SINK="$REPO/tmp-forecast/hires-branch"
SINK_URL="https://github.com/bmmmm/pegel-visual.git"
SINK_BRANCH=hires

for tool in node git gh rsync; do
  command -v "$tool" >/dev/null 2>&1 || { printf 'collect-hires.sh: %s not on PATH (%s)\n' "$tool" "$PATH" >&2; exit 1; }
done

report() { # <ok|partial|failed> <message ≤140 chars>
  local outcome="$1" msg="$2"
  command -v wallii >/dev/null 2>&1 || { printf 'collect-hires.sh: wallii not on PATH — no heartbeat for cron:%s\n' "$LABEL" >&2; return 0; }
  WALLII_ACTOR="cron:$LABEL" wallii post -t chore --outcome "$outcome" --took none "${msg:0:140}" >/dev/null \
    || printf 'collect-hires.sh: wall post for cron:%s rejected (see above)\n' "$LABEL" >&2
  return 0
}

# the local clone of the data branch: created on first use, seeded as an orphan
# when the branch does not exist on GitHub yet
sink_prepare() {
  if [ ! -d "$SINK/.git" ]; then
    if git ls-remote --exit-code --heads "$SINK_URL" "$SINK_BRANCH" >/dev/null 2>&1; then
      git clone --quiet --origin github --branch "$SINK_BRANCH" --single-branch "$SINK_URL" "$SINK"
    else
      git init --quiet -b "$SINK_BRANCH" "$SINK"
      git -C "$SINK" remote add github "$SINK_URL"
      cat > "$SINK/README.md" <<'EOF'
# hires — 15-minute gauge readings for the short-horizon forecast gate

Data branch, written weekly by `scripts/forecast/collect-hires.sh` on one
machine, mirrored here so the collection survives that machine. GitHub-only,
like `archive`; only ever fast-forwarded.

Layout: `hires/<uuid>/<YYYY-MM>.json` — one UTC month of `[isoUtc, value]`
pairs in the gauge's own unit (cm for the collected set), plus
`hires/<uuid>/runs.json` with the run log. Source: PEGELONLINE REST
`?start=P35D` (clamped to ~31 days by the server), merged idempotently by
timestamp; sentinels outside the plausibility bounds are dropped on arrival.
Nothing is thinned or deleted. CUXHAVEN publishes at 1-minute resolution.
EOF
    fi
    git -C "$SINK" config credential.https://github.com.helper '!gh auth git-credential'
  fi
  if git -C "$SINK" rev-parse --verify --quiet "refs/remotes/github/$SINK_BRANCH" >/dev/null; then
    git -C "$SINK" fetch --quiet github "$SINK_BRANCH"
    git -C "$SINK" reset --quiet --hard "github/$SINK_BRANCH"
  fi
}

sink_push() {
  sink_prepare
  mkdir -p "$SINK/hires"
  rsync -a --exclude '.DS_Store' "$DATA/" "$SINK/hires/"
  git -C "$SINK" add -A
  if git -C "$SINK" diff --cached --quiet; then
    printf 'sink: nothing new on %s\n' "$SINK_BRANCH"
    return 0
  fi
  git -C "$SINK" commit --quiet -m "hires: collect $(date -u +%Y-%m-%d)"
  git -C "$SINK" push --quiet github "HEAD:$SINK_BRANCH"
  printf 'sink: pushed %s\n' "$(git -C "$SINK" rev-parse --short HEAD)"
}

printf '%s collect-hires start\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if ! out="$(node scripts/forecast/collect-hires.mjs 2>&1)"; then
  printf '%s\n' "$out" >&2
  report failed "hires collect failed: ${out##*$'\n'}"
  exit 1
fi
printf '%s\n' "$out"
summary="${out##*$'\n'}"

if sink_out="$(sink_push 2>&1)"; then
  printf '%s\n' "$sink_out"
  report ok "hires collect: ${summary} · ${sink_out##*$'\n'}"
else
  printf '%s\n' "$sink_out" >&2
  report partial "hires collected, mirror to ${SINK_BRANCH} failed: ${sink_out##*$'\n'}"
  exit 1
fi
