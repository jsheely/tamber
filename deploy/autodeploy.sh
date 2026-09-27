#!/usr/bin/env bash
# Tamber auto-deploy: pull-based continuous deployment for a single Docker host.
#
# Every run fetches origin/<branch> in a dedicated deploy clone. When the tip moved since the last
# deploy, it hard-resets the clone to it, rebuilds the image, swaps the container and removes the
# previous image. Designed to be run by a systemd timer (see tamber-autodeploy.timer), but
# `tamber-autodeploy` by hand works too. `FORCE=1 tamber-autodeploy` redeploys the current tip.
#
# Configuration (environment, normally from ~/.config/tamber-autodeploy.env):
#   TAMBER_DEPLOY_DIR      deploy clone            (default: ~/deploy/tamber)
#   TAMBER_DEPLOY_BRANCH   branch to follow        (default: main)
#   TAMBER_DEPLOY_SERVICE  compose service to run  (default: tamber; use tamber-gpu for CUDA)
#   TAMBER_DEPLOY_HEALTH_TIMEOUT  seconds to wait for the container to turn healthy (default: 300)
#
# The whole script is one function so that the `git reset` below cannot change the file while
# bash is still reading it.
set -euo pipefail

main() {
  local deploy_dir="${TAMBER_DEPLOY_DIR:-$HOME/deploy/tamber}"
  local branch="${TAMBER_DEPLOY_BRANCH:-main}"
  local service="${TAMBER_DEPLOY_SERVICE:-tamber}"
  local health_timeout="${TAMBER_DEPLOY_HEALTH_TIMEOUT:-300}"

  local -a compose=(docker compose)
  local other_service="tamber-gpu"
  if [[ "$service" == "tamber-gpu" ]]; then
    compose+=(--profile gpu)
    other_service="tamber"
  fi

  cd "$deploy_dir"
  git fetch --quiet origin "$branch"
  local remote deployed
  remote="$(git rev-parse "origin/$branch")"
  deployed="$(cat .deployed-rev 2>/dev/null || true)"

  if [[ "$remote" == "$deployed" && -z "${FORCE:-}" ]]; then
    exit 0 # nothing new; stay quiet so the journal only shows real deploys
  fi

  echo "tamber-autodeploy: ${deployed:-(none)} -> $remote ($service)"
  git reset --hard --quiet "origin/$branch"
  git log -1 --format='  %h %an: %s'

  # Remember the image currently serving traffic so it can be removed after the swap.
  local old_container old_image=""
  old_container="$("${compose[@]}" ps -q "$service" 2>/dev/null | head -1 || true)"
  if [[ -n "$old_container" ]]; then
    old_image="$(docker inspect --format '{{.Image}}' "$old_container" 2>/dev/null || true)"
  fi

  # Build first so the running container keeps serving until the new image is ready.
  "${compose[@]}" build "$service"

  # The CPU and GPU services share port 8880: make sure the other one is gone before starting.
  "${compose[@]}" rm --stop --force "$other_service" >/dev/null 2>&1 || true
  "${compose[@]}" up --detach --no-build --remove-orphans "$service"

  # From here on the new revision is what is deployed, even if the health check below fails.
  echo "$remote" > .deployed-rev

  local new_container new_image
  new_container="$("${compose[@]}" ps -q "$service" | head -1)"
  new_image="$(docker inspect --format '{{.Image}}' "$new_container")"
  if [[ -n "$old_image" && "$old_image" != "$new_image" ]]; then
    docker image rm "$old_image" >/dev/null 2>&1 && echo "  removed previous image ${old_image:7:12}" || true
  fi

  # Wait for the HEALTHCHECK (model load can take a while; the Dockerfile allows 180 s).
  local waited=0 status
  while (( waited < health_timeout )); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$new_container" 2>/dev/null || echo missing)"
    case "$status" in
      healthy) echo "  healthy after ${waited}s"; return 0 ;;
      unhealthy|missing) echo "  container is $status; see: docker logs $new_container" >&2; return 1 ;;
    esac
    sleep 5; waited=$((waited + 5))
  done
  echo "  still not healthy after ${health_timeout}s; see: docker logs $new_container" >&2
  return 1
}

main "$@"; exit $?
