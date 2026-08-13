#!/usr/bin/env bash
# LCOS (Letena Content OS) — one-command deploy, Letena v2 / Fidelify pattern.
# Usage: ./deploy.sh "your commit message"
#
# Unlike letenav2 (which auto-deploys from GitHub via a Plesk webhook), LCOS
# does NOT auto-deploy. Pushing to GitHub only gets the code onto `main` —
# the Hetzner box (lcos-1) still has to pull, migrate, and restart before the
# change is actually live. This script does both: push, then try to finish
# the job over SSH. If SSH to lcos-1 isn't set up on this machine, it tells
# you exactly what to run by hand instead of hanging or failing silently.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MSG="${1:-deploy: $(date '+%Y-%m-%d %H:%M')}"
cd "$REPO"

LCOS_HOST="${LCOS_DEPLOY_HOST:-lcos-1}"   # SSH config alias for 204.168.161.47, Hetzner
LCOS_USER="${LCOS_DEPLOY_USER:-root}"
LCOS_PATH="${LCOS_DEPLOY_PATH:-/opt/lcos}"
# Deliberately the "lcos-1" alias, not the bare IP (confirmed working
# 13 Aug 2026: `ssh lcos-1` succeeds from this machine every time; `ssh
# root@204.168.161.47` does not, because ~/.ssh/config's Host block is
# matched against the literal name "lcos-1" on the command line, not
# against the address it resolves to. Using the raw IP here silently
# skipped that config block (wrong/no identity file, wrong user) and made
# every deploy report "SSH not configured" even though it plainly was.

# --- resolve a working node CLI ------------------------------------------
NODE="${LCOS_NODE:-}"
if [ -z "$NODE" ] || ! "$NODE" -v >/dev/null 2>&1; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE" ]; then
  echo "✗ No working node CLI found. Set LCOS_NODE=/path/to/node and retry."; exit 1
fi
echo "• using node: $NODE ($("$NODE" -v))"

# --- security guard --------------------------------------------------------
for f in .env apps/api/.env; do
  if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    echo "✗ $f is tracked in git — it holds secrets and must stay local-only. Aborting."; exit 1
  fi
done

# --- syntax check (changed JS/mjs files) — no DB needed for this ----------
echo "• node --check (changed files)"
CHECK_FAIL=0; CHECK_N=0
while IFS= read -r f; do
  [ -n "$f" ] && [ -f "$f" ] || continue
  case "$f" in *.js|*.mjs) ;; *) continue;; esac
  CHECK_N=$((CHECK_N + 1))
  if ! "$NODE" --check "$f" >/dev/null 2>&1; then
    echo "  ✗ syntax error in $f"; "$NODE" --check "$f"; CHECK_FAIL=1
  fi
done < <(git ls-files -mo --exclude-standard -- '*.js' '*.mjs')
[ "$CHECK_FAIL" -eq 0 ] || { echo "✗ Syntax check failed — not deploying."; exit 1; }
echo "  ok — $CHECK_N changed file(s) checked"

# --- commit + push ----------------------------------------------------------
echo "• git add -A && commit && push"
rm -f .git/index.lock 2>/dev/null || true
git add -A
if git diff --cached --quiet; then
  echo "  (nothing staged — pushing current HEAD as-is)"
else
  git commit -m "$MSG" || { echo "✗ commit failed"; exit 1; }
fi
git push || { echo "✗ push failed"; exit 1; }
PUSHED_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
echo "  ✓ pushed $PUSHED_SHA to origin/main"

# --- remote deploy over SSH (best-effort) -----------------------------------
echo "• deploying to lcos-1 ($LCOS_HOST) over SSH"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new)
# Was `2>/dev/null` -- swallowed the real reason every failure, so "not
# configured" printed identically whether SSH was truly unreachable, a key
# needed a passphrase BatchMode can't prompt for, or something else
# entirely. Capture stderr and print it on failure instead of guessing again.
SSH_CHECK_ERR="$(ssh "${SSH_OPTS[@]}" "$LCOS_USER@$LCOS_HOST" "true" 2>&1 1>/dev/null)"
SSH_CHECK_STATUS=$?
if [ "$SSH_CHECK_STATUS" -eq 0 ]; then
  echo "  ssh reachable — pulling, migrating, restarting"
  # migrate has intermittently thrown a transient "password authentication
  # failed for user lcos" (Postgres auth blip, code 28P01) with nothing
  # actually pending — happened 3x in one night, 12-13 Aug 2026. Previously
  # this was chained with a single &&, so one flaky migrate attempt aborted
  # the whole deploy *before* the restart step ever ran, even though the
  # new code had already landed on disk via git pull. Retry migrate a few
  # times first (cheap, and fixes the common transient case automatically);
  # only if it still fails after retries do we stop short of restarting —
  # that part stays a hard stop on purpose, since restarting app code that
  # expects a schema change which never applied is worse than a delayed
  # deploy.
  REMOTE_CMD='cd '"$LCOS_PATH"' && git pull && \
    ok=0; for i in 1 2 3 4; do \
      npm run migrate && { ok=1; break; }; \
      echo "  (migrate attempt $i failed, retrying in 3s...)"; sleep 3; \
    done; \
    if [ "$ok" -ne 1 ]; then echo "MIGRATE_FAILED_AFTER_RETRIES"; exit 1; fi; \
    systemctl restart lcos-api && sleep 2 && systemctl is-active lcos-api'
  if ssh "${SSH_OPTS[@]}" "$LCOS_USER@$LCOS_HOST" "$REMOTE_CMD"; then
    echo "  ✓ lcos-api pulled, migrated, and restarted on lcos-1"
  else
    echo "  ✗ remote deploy steps failed partway — check lcos-1 by hand:"
    echo "      ssh $LCOS_USER@$LCOS_HOST"
    echo "      cd $LCOS_PATH && git pull && npm run migrate && systemctl restart lcos-api"
    exit 1
  fi
else
  cat <<EOF
  ⚠ Couldn't reach lcos-1 over SSH from this machine (not configured, or
    key/host not set up yet). Code is pushed to GitHub, but it is NOT live
    yet — LCOS has no auto-deploy webhook. Finish it by hand, either via
    the Hetzner web console or SSH once it's set up:

      cd $LCOS_PATH && git pull && npm run migrate && systemctl restart lcos-api

    To make this script finish the job automatically next time, set up SSH
    access to lcos-1 (ssh-copy-id, or add a Host entry in ~/.ssh/config for
    $LCOS_HOST), or override LCOS_DEPLOY_HOST / LCOS_DEPLOY_USER /
    LCOS_DEPLOY_PATH as env vars if any of those differ.

    Actual SSH error (exit $SSH_CHECK_STATUS):
    ${SSH_CHECK_ERR:-<no stderr output -- likely a plain connect timeout>}
EOF
fi

echo "----------------------------------------"
echo "✓ Done — pushed $PUSHED_SHA."
