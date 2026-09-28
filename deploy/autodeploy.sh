#!/usr/bin/env bash
# Tamber auto-deploy: pull-based continuous deployment for a single Docker host.
#
#   tamber-autodeploy          poll: fetch origin/<branch>; if it moved since the last deploy, deploy it
#   tamber-autodeploy status   show what is deployed, what origin/<branch> is at, and the container state
#   tamber-autodeploy deploy   rebuild and redeploy the current origin/<branch> tip even if unchanged
#
# The systemd timer (tamber-autodeploy.timer) runs the poll form every minute. A deploy hard-resets
# the deploy clone to the tip, builds the image with TAMBER_REVISION=<commit> (visible as the
# org.opencontainers.image.revision label and in GET /v1/health), swaps the container and removes
# the previous image. The running container keeps serving until the new image is built.
#
# Configuration (environment, normally from ~/.config/tamber-autodeploy.env):
#   TAMBER_DEPLOY_DIR      deploy clone            (default: ~/deploy/tamber)
#   TAMBER_DEPLOY_BRANCH   branch to follow        (default: main)
#   TAMBER_DEPLOY_SERVICE  compose service to run  (default: tamber; use tamber-gpu for CUDA)
#   TAMBER_DEPLOY_HEALTH_TIMEOUT  seconds to wait for the container to turn healthy (default: 300)
#
# Everything is wrapped in functions and the last line exits explicitly, so the `git reset` cannot
# change this file while bash is still reading it.
set -euo pipefail

deploy_dir="${TAMBER_DEPLOY_DIR:-$HOME/deploy/tamber}"
branch="${TAMBER_DEPLOY_BRANCH:-main}"
service="${TAMBER_DEPLOY_SERVICE:-tamber}"
health_timeout="${TAMBER_DEPLOY_HEALTH_TIMEOUT:-300}"

compose=(docker compose)
other_service="tamber-gpu"
if [[ "$service" == "tamber-gpu" ]]; then
  compose+=(--profile gpu)
  other_service="tamber"
fi

short() { printf '%s' "${1:0:7}"; }

container_id() { "${compose[@]}" ps -q "$service" 2>/dev/null | head -1 || true; }

status() {
  cd "$deploy_dir"
  git fetch --quiet origin "$branch"
  local remote deployed cid
  remote="$(git rev-parse "origin/$branch")"
  deployed="$(cat .deployed-rev 2>/dev/null || true)"

  echo "origin/$branch:  $(short "$remote")  $(git log -1 --format='%ci  %s' "$remote" | cut -c1-90)"
  if [[ -n "$deployed" ]]; then
    echo "deployed:     $(short "$deployed")  $(git log -1 --format='%ci  %s' "$deployed" 2>/dev/null | cut -c1-90)"
  else
    echo "deployed:     (nothing deployed by this tool yet)"
  fi

  cid="$(container_id)"
  if [[ -z "$cid" ]]; then
    echo "container:    not running ($service)"
  else
    local built health created
    built="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
    created="$(docker inspect --format '{{.Created}}' "$cid" | cut -c1-19 | tr T ' ')"
    echo "container:    $service  $health  started ${created} UTC  image built from ${built:+$(short "$built")}${built:-(unknown: image predates revision labels)}"
  fi

  local next_run
  next_run="$(systemctl --user list-timers tamber-autodeploy.timer --no-pager --no-legend 2>/dev/null | awk '{print $1" "$2" "$3" "$4" (in "$5")"}')"
  echo "timer:        $(systemctl --user is-active tamber-autodeploy.timer 2>/dev/null || echo unknown); next run ${next_run:-unknown}"

  if [[ "$remote" == "$deployed" ]]; then
    echo "up to date."
  else
    echo "BEHIND: origin/$branch has $(git rev-list --count "${deployed:-$remote}..$remote" 2>/dev/null || echo '?') new commit(s); the timer deploys within a minute, or run: tamber-autodeploy deploy"
    return 1
  fi
}

deploy() {
  local force="${1:-}"
  cd "$deploy_dir"
  git fetch --quiet origin "$branch"
  local remote deployed
  remote="$(git rev-parse "origin/$branch")"
  deployed="$(cat .deployed-rev 2>/dev/null || true)"

  if [[ "$remote" == "$deployed" && -z "$force" ]]; then
    return 0 # nothing new; stay quiet so the journal only shows real deploys
  fi

  echo "tamber-autodeploy: ${deployed:-(none)} -> $remote ($service)"
  git reset --hard --quiet "origin/$branch"
  git log -1 --format='  %h %an: %s'

  # Remember the image currently serving traffic so it can be removed after the swap.
  local old_container old_image=""
  old_container="$(container_id)"
  if [[ -n "$old_container" ]]; then
    old_image="$(docker inspect --format '{{.Image}}' "$old_container" 2>/dev/null || true)"
  fi

  # Build first so the running container keeps serving until the new image is ready.
  "${compose[@]}" build --build-arg "TAMBER_REVISION=$remote" "$service"

  # The CPU and GPU services share port 8880: make sure the other one is gone before starting.
  "${compose[@]}" rm --stop --force "$other_service" >/dev/null 2>&1 || true
  "${compose[@]}" up --detach --no-build --remove-orphans "$service"

  # From here on the new revision is what is deployed, even if the health check below fails.
  echo "$remote" > .deployed-rev

  local new_container new_image
  new_container="$(container_id)"
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

main() {
  case "${1:-poll}" in
    poll)   deploy "${FORCE:-}" ;;
    deploy) deploy force ;;
    status) status ;;
    *) echo "usage: tamber-autodeploy [poll|status|deploy]" >&2; return 2 ;;
  esac
}

main "$@"; exit $?
