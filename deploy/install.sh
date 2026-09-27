#!/usr/bin/env bash
# Sets up pull-based auto-deploy on this Docker host (run as the user who owns the containers):
#   1. clones the repo into the deploy directory (default ~/deploy/tamber),
#   2. seeds its .env from the checkout this script runs from (if any; .env is gitignored),
#   3. installs autodeploy.sh as ~/.local/bin/tamber-autodeploy plus a systemd --user timer,
#   4. enables lingering so the timer runs without a login session.
#
#   ./deploy/install.sh                       # CPU service (default)
#   TAMBER_DEPLOY_SERVICE=tamber-gpu ./deploy/install.sh
#
# Re-running is safe; it refreshes the script and units and keeps the existing config.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
deploy_dir="${TAMBER_DEPLOY_DIR:-$HOME/deploy/tamber}"
branch="${TAMBER_DEPLOY_BRANCH:-main}"
service="${TAMBER_DEPLOY_SERVICE:-tamber}"
remote_url="${TAMBER_DEPLOY_REMOTE:-$(git -C "$repo_root" remote get-url origin)}"
config="$HOME/.config/tamber-autodeploy.env"

if [[ ! -d "$deploy_dir/.git" ]]; then
  echo "Cloning $remote_url ($branch) into $deploy_dir"
  git clone --quiet --branch "$branch" "$remote_url" "$deploy_dir"
fi

if [[ ! -e "$deploy_dir/.env" && -f "$repo_root/.env" ]]; then
  cp "$repo_root/.env" "$deploy_dir/.env"
  echo "Copied $repo_root/.env to $deploy_dir/.env (edit that one from now on)"
fi

mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 0755 "$here/autodeploy.sh" "$HOME/.local/bin/tamber-autodeploy"
install -m 0644 "$here/tamber-autodeploy.service" "$here/tamber-autodeploy.timer" "$HOME/.config/systemd/user/"

if [[ ! -e "$config" ]]; then
  cat > "$config" <<CFG
# Read by tamber-autodeploy.service. Change, then: systemctl --user restart tamber-autodeploy.timer
TAMBER_DEPLOY_DIR=$deploy_dir
TAMBER_DEPLOY_BRANCH=$branch
# tamber (CPU) or tamber-gpu (CUDA, needs the NVIDIA Container Toolkit)
TAMBER_DEPLOY_SERVICE=$service
CFG
  echo "Wrote $config"
fi

loginctl enable-linger "$USER" 2>/dev/null || echo "Could not enable lingering; run: sudo loginctl enable-linger $USER"

systemctl --user daemon-reload
systemctl --user enable --now tamber-autodeploy.timer
echo
echo "Installed. The first run deploys origin/$branch right away; follow it with:"
echo "  journalctl --user -u tamber-autodeploy -f"
echo "Status: systemctl --user list-timers tamber-autodeploy.timer"
