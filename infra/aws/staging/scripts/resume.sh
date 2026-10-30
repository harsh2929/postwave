#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# resume.sh -- NON-PRODUCTION. Undoes pause.sh: starts the Postgres EC2
# instance, waits for its status checks, then gives every service whose
# services-stack Deploy* flag is true one task again, in dependency order:
# clamav and listmonk first (the API exits at boot unless clamd answers),
# then api, then web, each waited on until ECS reports it stable.
#
# Tag-interlocked exactly like pause.sh: both stacks, the ECS cluster, every
# service it scales and the database instance must carry
# Project=moosewave-staging. The instance keeps its private IP across a stop,
# so db.postwave.internal needs no change.
#
# Environment: DRY_RUN=1 prints what would start and changes nothing.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq
case "${1:-}" in -h|--help) usage_from_header "$0"; exit 0 ;; "") ;; *) usage_from_header "$0" >&2; exit 2 ;; esac

flag_for() { # <service> -> its services.yaml Deploy* parameter
  case "$1" in
    postwave-clamav) echo DeployClamav ;;
    postwave-listmonk) echo DeployListmonk ;;
    postwave-api) echo DeployApi ;;
    postwave-web) echo DeployWeb ;;
  esac
}

wait_stable() { # <cluster> <service...>: running == desired, one deployment
  local cluster="$1" deadline stable
  shift
  deadline=$(( $(now) + 1500 ))
  while :; do
    stable=$(awsx "$APP_REGION" ecs describe-services --cluster "$cluster" --services "$@" --output json |
      jq -r '[.services[] | select(.runningCount == .desiredCount and (.deployments | length) == 1)] | length') || return 1
    [ "$stable" != "$#" ] || return 0
    [ "$(now)" -lt "$deadline" ] || { log "not stable after 25 minutes: $*"; return 1; }
    sleep 15
  done
}

step "interlock"
base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
services_status=$(stack_status "$APP_REGION" "$STACK_SERVICES")
status_is_complete "$base_status" || die "$STACK_BASE is $base_status"
status_is_complete "$services_status" || die "$STACK_SERVICES is $services_status"
require_staging_stack "$APP_REGION" "$STACK_BASE"
require_staging_stack "$APP_REGION" "$STACK_SERVICES"
cluster=$(stack_output "$APP_REGION" "$STACK_BASE" ClusterName)
instance=$(stack_output "$APP_REGION" "$STACK_BASE" DbInstanceId)
cluster_tag=$(awsx "$APP_REGION" ecs describe-clusters --clusters "$cluster" --include TAGS \
  --query "clusters[0].tags[?key=='$PROJECT_TAG_KEY'].value | [0]" --output text)
require_tagged "ECS cluster $cluster" "$cluster_tag"
instance_json=$(awsx "$APP_REGION" ec2 describe-instances --instance-ids "$instance" \
  --query 'Reservations[0].Instances[0]' --output json)
instance_tag=$(printf '%s' "$instance_json" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.Tags // [])[] | select(.Key == $k) | .Value][0] // ""')
require_tagged "database instance $instance" "$instance_tag"
# shellcheck disable=SC2086 # the fixed service list splits on purpose
services_json=$(awsx "$APP_REGION" ecs describe-services --cluster "$cluster" \
  --services $SERVICES_START_ORDER --include TAGS --output json)
wanted=""
for service in $SERVICES_START_ORDER; do
  flag=$(stack_param "$APP_REGION" "$STACK_SERVICES" "$(flag_for "$service")")
  row=$(printf '%s' "$services_json" | jq -c --arg n "$service" \
    '[.services[] | select(.serviceName == $n and .status == "ACTIVE")][0] // empty')
  [ -n "$row" ] || die "ECS service $service does not exist; deploy.sh services creates it"
  tag=$(printf '%s' "$row" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.tags // [])[] | select(.key == $k) | .value][0] // ""')
  require_tagged "ECS service $service" "$tag"
  if [ "$flag" = true ]; then wanted="$wanted $service"; fi
done
log "  interlock passed; services to start:${wanted:- none (every Deploy* flag is false)}"

step "database instance $instance"
state=$(printf '%s' "$instance_json" | jq -r '.State.Name')
case "$state" in
  running) log "  already running" ;;
  stopped)
    if is_dry_run; then plan "start $instance and wait for its status checks"
    else
      awsx "$APP_REGION" ec2 start-instances --instance-ids "$instance" --output text >/dev/null
      awsx "$APP_REGION" ec2 wait instance-running --instance-ids "$instance"
      log "  running; waiting for the status checks (Postgres starts with the instance)"
      awsx "$APP_REGION" ec2 wait instance-status-ok --instance-ids "$instance"
      log "  status checks ok"
    fi ;;
  *) die "$instance is $state; wait for it to settle, then rerun" ;;
esac

scale_up() { # <service...>
  local service desired started=""
  for service in "$@"; do
    case " $wanted " in *" $service "*) ;; *) continue ;; esac
    desired=$(printf '%s' "$services_json" | jq -r --arg n "$service" '[.services[] | select(.serviceName == $n)][0].desiredCount')
    if [ "$desired" != 0 ]; then log "  $service: already $desired"; started="$started $service"; continue; fi
    if is_dry_run; then plan "scale $service from 0 to 1"; continue; fi
    awsx "$APP_REGION" ecs update-service --cluster "$cluster" --service "$service" --desired-count 1 \
      --query 'service.serviceName' --output text >/dev/null || return 1
    log "  $service: 0 -> 1"
    started="$started $service"
  done
  if [ -n "$started" ] && ! is_dry_run; then
    log "  waiting for$started"
    # shellcheck disable=SC2086
    wait_stable "$cluster" $started || return 1
    log "  stable:$started"
  fi
}

step "services"
scale_up postwave-clamav postwave-listmonk
scale_up postwave-api
scale_up postwave-web

step "resumed"
log "check it: smoke.sh"
