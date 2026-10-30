#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# migrate.sh -- NON-PRODUCTION. Applies the repository's migrations to the
# staging Postgres by running the migrator task (services.yaml
# MigratorTaskDefinition) as the superuser postgres, exactly as CI migrates.
#
#   migrate.sh [--allow-unsafe-bootstrap]
#
# Run 1 is plain and must exit 0: migrations applied (or none pending) and
# verified. Exit 5 means the migrator refused an unsafe migration. That is
# expected once, on the first bootstrap of an EMPTY database (it replays
# migration 0339's reviewed partition cutover); rerun with
# --allow-unsafe-bootstrap and the script first proves the database has no
# applied migrations (a POSTWAVE_MIGRATOR_DRY_RUN task must report
# "applied: 0"), then repeats the run with POSTWAVE_MIGRATOR_ALLOW_UNSAFE=1.
# A database that already has migrations never gets the override.
# The last run is always plain again and must report "migrations: nothing to
# do": the proof that the result is complete and idempotent. Every applying
# run must also log the migrator's own checks, "verified migrations: ...
# checksums=match" and "consent evidence preflight passed".
#
# Each task runs on Fargate in the public subnets with a public IP and the
# migrator security group (base.yaml MigratorNetworkConfiguration), carries
# the task definition's Project=moosewave-staging tag, and is started by
# moosewave-staging-migrate. The complete log of every run is saved under
# $STAGING_STATE_DIR/migrate/ and its end is printed.
#
# Environment: DRY_RUN=1 checks the prerequisites and prints the task it
# would run; AWS_PROFILE as usual.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq

allow_unsafe_bootstrap=0
for arg in "$@"; do
  case "$arg" in
    --allow-unsafe-bootstrap) allow_unsafe_bootstrap=1 ;;
    -h|--help) usage_from_header "$0"; exit 0 ;;
    *) usage_from_header "$0" >&2; exit 2 ;;
  esac
done

readonly EXIT_UNSAFE=5
readonly STARTED_BY=moosewave-staging-migrate

# ------------------------------------------------------------- prerequisites
step "prerequisites"
base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
services_status=$(stack_status "$APP_REGION" "$STACK_SERVICES")
status_is_complete "$base_status" || die "$STACK_BASE is $base_status"
status_is_complete "$services_status" || die "$STACK_SERVICES is $services_status (deploy.sh services creates the migrator task definition)"
require_staging_stack "$APP_REGION" "$STACK_BASE"
require_staging_stack "$APP_REGION" "$STACK_SERVICES"
cluster=$(stack_output "$APP_REGION" "$STACK_BASE" ClusterName)
network=$(stack_output "$APP_REGION" "$STACK_BASE" MigratorNetworkConfiguration)
log_group=$(stack_output "$APP_REGION" "$STACK_BASE" MigratorLogGroupName)
db_instance=$(stack_output "$APP_REGION" "$STACK_BASE" DbInstanceId)
task_definition=$(stack_output "$APP_REGION" "$STACK_SERVICES" MigratorTaskDefinitionArn)
container=$(stack_output "$APP_REGION" "$STACK_SERVICES" MigratorContainerName)
digest=$(stack_param "$APP_REGION" "$STACK_SERVICES" MigratorImageDigest)
[ -n "$cluster" ] && [ -n "$network" ] && [ -n "$log_group" ] && [ -n "$db_instance" ] ||
  die "$STACK_BASE is missing outputs this script needs"
[ -n "$task_definition" ] && [ -n "$container" ] || die "$STACK_SERVICES has no migrator task definition output"
[ "$digest" != "$ZERO_DIGEST" ] ||
  die "the migrator task definition still points at the placeholder image; build db-migrator (build-images.sh) and run deploy.sh services"

cluster_tag=$(awsx "$APP_REGION" ecs describe-clusters --clusters "$cluster" --include TAGS \
  --query "clusters[0].tags[?key=='$PROJECT_TAG_KEY'].value | [0]" --output text)
require_tagged "ECS cluster $cluster" "$cluster_tag"
db_state=$(awsx "$APP_REGION" ec2 describe-instances --instance-ids "$db_instance" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
[ "$db_state" = running ] || die "the database instance $db_instance is $db_state; run resume.sh first"
log "  cluster $cluster, task definition ${task_definition##*/}, database $db_instance running"

if is_dry_run; then
  plan "run ${task_definition##*/} on $cluster ($network), plainly first, and a final plain verification run"
  [ "$allow_unsafe_bootstrap" = 0 ] ||
    plan "on an exit-$EXIT_UNSAFE refusal: a dry-run task must show 'applied: 0', then one run with POSTWAVE_MIGRATOR_ALLOW_UNSAFE=1"
  exit 0
fi

ensure_state_dir
mkdir -p "$STAGING_STATE_DIR/migrate"

# -------------------------------------------------------------------- tasks
# fetch_log <task id> <file>: the task's complete log, oldest first.
fetch_log() {
  local stream="migrate/$container/$1" out="$2" token="" next page="$STAGING_TMP/log-page.json"
  : >"$out"
  while :; do
    if [ -n "$token" ]; then
      awsx "$APP_REGION" logs get-log-events --log-group-name "$log_group" --log-stream-name "$stream" \
        --start-from-head --next-token "$token" --output json >"$page" 2>/dev/null || return 1
    else
      awsx "$APP_REGION" logs get-log-events --log-group-name "$log_group" --log-stream-name "$stream" \
        --start-from-head --output json >"$page" 2>/dev/null || return 1
    fi
    jq -r '.events[].message' "$page" >>"$out" || return 1
    next=$(jq -r '.nextForwardToken // ""' "$page") || return 1
    if [ -z "$next" ] || [ "$next" = "$token" ]; then return 0; fi
    token=$next
  done
}

# run_task <label> [<environment overrides as JSON array>]
# Sets RUN_EXIT (the container exit code) and RUN_LOG (the saved log file).
run_task() {
  local label="$1" env_json="${2:-}" overrides="" response task_arn task_id status last="" deadline
  local exit_code stop_reason lines count
  step "migrator run: $label"
  if [ -n "$env_json" ]; then
    overrides=$(jq -cn --arg c "$container" --argjson e "$env_json" \
      '{containerOverrides: [{name: $c, environment: $e}]}')
  fi
  set -- --cluster "$cluster" --launch-type FARGATE --task-definition "$task_definition" \
    --network-configuration "$network" --count 1 --started-by "$STARTED_BY" \
    --propagate-tags TASK_DEFINITION --enable-ecs-managed-tags
  [ -z "$overrides" ] || set -- "$@" --overrides "$overrides"
  response=$(awsx "$APP_REGION" ecs run-task "$@" --output json)
  task_arn=$(printf '%s' "$response" | jq -r '.tasks[0].taskArn // ""')
  [ -n "$task_arn" ] || die "run-task started nothing: $(printf '%s' "$response" | jq -c '.failures')"
  task_id=${task_arn##*/}
  log "  task $task_id"
  deadline=$(( $(now) + 45 * 60 ))
  while :; do
    status=$(awsx "$APP_REGION" ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
      --query 'tasks[0].lastStatus' --output text)
    [ "$status" = "$last" ] || log "  $(date -u +%H:%M:%S) $status"
    last=$status
    [ "$status" != STOPPED ] || break
    [ "$(now)" -lt "$deadline" ] || die "task $task_id still $status after 45 minutes"
    sleep 10
  done
  exit_code=$(awsx "$APP_REGION" ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query "tasks[0].containers[?name=='$container'].exitCode | [0]" --output text)
  stop_reason=$(awsx "$APP_REGION" ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query "[tasks[0].stopCode, tasks[0].stoppedReason, tasks[0].containers[?name=='$container'].reason | [0]]" \
    --output text | tr '\t' ' ')
  RUN_LOG="$STAGING_STATE_DIR/migrate/$(date -u +%Y%m%dT%H%M%SZ)-$task_id.log"
  # CloudWatch delivers the last lines a few seconds after the task stops:
  # read until two reads agree (and the log is not empty).
  lines=-1
  for _ in 1 2 3 4 5 6 7 8; do
    fetch_log "$task_id" "$RUN_LOG" || true
    count=$(wc -l <"$RUN_LOG" | tr -d ' ')
    if [ "$count" -gt 0 ] && [ "$count" = "$lines" ]; then break; fi
    lines=$count
    sleep 5
  done
  log "  exit ${exit_code} (${stop_reason}); $(wc -l <"$RUN_LOG" | tr -d ' ') log lines saved to $RUN_LOG"
  tail -n 25 "$RUN_LOG" | sed 's/^/    /' >&2
  case "$exit_code" in
    ''|None) die "the migrator container never ran to completion: $stop_reason" ;;
  esac
  RUN_EXIT=$exit_code
}

require_verified_log() { # <log file>
  grep -q 'verified migrations: count=.* checksums=match' "$1" ||
    die "the run exited 0 but its log has no 'verified migrations ... checksums=match' line"
  grep -q 'consent evidence preflight passed' "$1" ||
    die "the run exited 0 but its log has no 'consent evidence preflight passed' line"
}

RUN_EXIT=""; RUN_LOG=""
run_task "plain"
case "$RUN_EXIT" in
  0) require_verified_log "$RUN_LOG" ;;
  "$EXIT_UNSAFE")
    grep -q 'unsafe migration detected' "$RUN_LOG" || die "exit $EXIT_UNSAFE without the unsafe-migration message; read $RUN_LOG"
    [ "$allow_unsafe_bootstrap" = 1 ] ||
      die "the migrator refused an unsafe migration (safety findings above). On the FIRST bootstrap of an empty staging database that is expected: rerun with --allow-unsafe-bootstrap."
    run_task "dry run (prove the database is empty)" '[{"name":"POSTWAVE_MIGRATOR_DRY_RUN","value":"1"}]'
    [ "$RUN_EXIT" = 0 ] || die "the dry-run task exited $RUN_EXIT"
    applied=$(awk '$1 == "applied:" { print $2; exit }' "$RUN_LOG")
    [ "$applied" = 0 ] ||
      die "the database already has ${applied:-an unknown number of} applied migrations; the unsafe override is only for an empty database"
    run_task "unsafe bootstrap (empty database, POSTWAVE_MIGRATOR_ALLOW_UNSAFE=1)" \
      '[{"name":"POSTWAVE_MIGRATOR_ALLOW_UNSAFE","value":"1"}]'
    [ "$RUN_EXIT" = 0 ] || die "the bootstrap run exited $RUN_EXIT; read $RUN_LOG"
    require_verified_log "$RUN_LOG" ;;
  *) die "the migrator exited $RUN_EXIT; read $RUN_LOG" ;;
esac

run_task "verification (plain, must be a no-op)"
[ "$RUN_EXIT" = 0 ] || die "the verification run exited $RUN_EXIT; read $RUN_LOG"
require_verified_log "$RUN_LOG"
grep -q 'migrations: nothing to do' "$RUN_LOG" ||
  die "the verification run applied migrations; it must be a no-op (read $RUN_LOG)"

step "migrated"
grep -o 'verified migrations: count=[^ ]* latest=[^ ]*' "$RUN_LOG" | tail -n 1 >&2
log "next: db-post-migrate.sh ops-login (postwave_ops needs its password before the API starts)"
