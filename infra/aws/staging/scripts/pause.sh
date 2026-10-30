#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# pause.sh -- NON-PRODUCTION. Stops the parts of Moosewave staging that cost
# the most while idle: every ECS service goes to 0 tasks (web, api, listmonk,
# clamav, in that order), then the Postgres EC2 instance stops. The ALB,
# Valkey, DNS, secrets and all data stay, so resume.sh brings the same
# environment back in a few minutes. Paused, staging costs about $1.7 a day
# instead of about $5.
#
# Tag-interlocked: it refuses unless both stacks, the ECS cluster, every
# service it scales and the database instance carry Project=moosewave-staging.
# It also refuses while a migrator task is running.
#
# The services stack's Deploy* flags are not changed; resume.sh restarts
# exactly the services whose flag is true, and a deploy.sh run that does not
# change a flag leaves the paused counts alone. While paused, the public
# hostnames still resolve and the ALB answers 503.
#
# Environment: DRY_RUN=1 prints what would stop and changes nothing.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq
case "${1:-}" in -h|--help) usage_from_header "$0"; exit 0 ;; "") ;; *) usage_from_header "$0" >&2; exit 2 ;; esac

step "interlock"
base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
status_is_complete "$base_status" || die "$STACK_BASE is $base_status; nothing to pause"
require_staging_stack "$APP_REGION" "$STACK_BASE"
services_status=$(stack_status "$APP_REGION" "$STACK_SERVICES")
cluster=$(stack_output "$APP_REGION" "$STACK_BASE" ClusterName)
instance=$(stack_output "$APP_REGION" "$STACK_BASE" DbInstanceId)
cluster_tag=$(awsx "$APP_REGION" ecs describe-clusters --clusters "$cluster" --include TAGS \
  --query "clusters[0].tags[?key=='$PROJECT_TAG_KEY'].value | [0]" --output text)
require_tagged "ECS cluster $cluster" "$cluster_tag"
instance_json=$(awsx "$APP_REGION" ec2 describe-instances --instance-ids "$instance" \
  --query 'Reservations[0].Instances[0]' --output json)
instance_tag=$(printf '%s' "$instance_json" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.Tags // [])[] | select(.Key == $k) | .Value][0] // ""')
require_tagged "database instance $instance" "$instance_tag"
migrations=$(awsx "$APP_REGION" ecs list-tasks --cluster "$cluster" --started-by moosewave-staging-migrate \
  --desired-status RUNNING --query 'length(taskArns)' --output text)
[ "$migrations" = 0 ] || die "a migrator task is running on $cluster; let it finish first"

services_json='{"services":[]}'
if [ "$services_status" != NONE ]; then
  require_staging_stack "$APP_REGION" "$STACK_SERVICES"
  # shellcheck disable=SC2086 # the fixed service list splits on purpose
  services_json=$(awsx "$APP_REGION" ecs describe-services --cluster "$cluster" \
    --services $SERVICES_START_ORDER --include TAGS --output json)
fi
log "  cluster and $instance are tagged $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE; each service is checked before it is scaled"

step "services to 0"
stopping=""
stop_order=$(printf '%s\n' "$SERVICES_START_ORDER" | tr ' ' '\n' | awk 'NF { a[++n] = $0 } END { for (i = n; i > 0; i--) print a[i] }')
for service in $stop_order; do
  row=$(printf '%s' "$services_json" | jq -c --arg n "$service" \
    '[.services[] | select(.serviceName == $n and .status == "ACTIVE")][0] // empty')
  [ -n "$row" ] || { log "  $service: not deployed"; continue; }
  tag=$(printf '%s' "$row" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.tags // [])[] | select(.key == $k) | .value][0] // ""')
  require_tagged "ECS service $service" "$tag"
  desired=$(printf '%s' "$row" | jq -r '.desiredCount')
  if [ "$desired" = 0 ]; then log "  $service: already 0"; continue; fi
  if is_dry_run; then plan "scale $service from $desired to 0"; continue; fi
  awsx "$APP_REGION" ecs update-service --cluster "$cluster" --service "$service" --desired-count 0 \
    --query 'service.serviceName' --output text >/dev/null
  log "  $service: $desired -> 0"
  stopping="$stopping $service"
done

if [ -n "$stopping" ]; then
  log "  waiting for the tasks to stop"
  deadline=$(( $(now) + 900 ))
  while :; do
    # shellcheck disable=SC2086
    running=$(awsx "$APP_REGION" ecs describe-services --cluster "$cluster" --services $stopping \
      --query 'sum(services[].runningCount)' --output text)
    [ "$running" != 0 ] || break
    [ "$(now)" -lt "$deadline" ] || die "$running task(s) still running after 15 minutes"
    sleep 10
  done
  log "  all tasks stopped"
fi

step "database instance $instance"
state=$(printf '%s' "$instance_json" | jq -r '.State.Name')
case "$state" in
  stopped) log "  already stopped" ;;
  running|pending)
    if is_dry_run; then plan "stop $instance (EBS data and its private IP stay)"
    else
      awsx "$APP_REGION" ec2 stop-instances --instance-ids "$instance" --output text >/dev/null
      awsx "$APP_REGION" ec2 wait instance-stopped --instance-ids "$instance"
      log "  stopped"
    fi ;;
  *) die "$instance is $state; wait for it to settle, then rerun" ;;
esac

step "paused"
log "resume with resume.sh; the digest and the fargate-vcpu alarm keep watching"
