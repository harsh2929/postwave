#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# db-post-migrate.sh -- NON-PRODUCTION. One-off steps on the staging Postgres
# host, sent through SSM Run Command (AWS-RunShellScript) and run there as the
# local postgres superuser over the Unix socket.
#
#   db-post-migrate.sh ops-login          after migrate.sh: migration 1700 creates
#       role postwave_ops NOLOGIN; this runs ALTER ROLE postwave_ops LOGIN
#       PASSWORD <postwave/staging/db-ops-password>, the password inside the
#       ops-db-dsn secret the API uses as OPS_DATABASE_URL. Run it before the
#       API starts.
#   db-post-migrate.sh listmonk-api-user  after listmonk's first healthy start:
#       creates or refreshes listmonk's API user "api" with the token in
#       postwave/staging/listmonk-admin-password (the API sends it as
#       LISTMONK_PASSWORD), and points listmonk's SMTP at its own loopback so
#       listmonk delivers no mail (its sends bypass the API's SES recipient
#       allowlist). Then restarts postwave-listmonk, because listmonk loads
#       API tokens and SMTP settings only at startup. listmonk v6.1.0 ignores
#       LISTMONK_ADMIN_API_PASSWORD, and its database settings override
#       LISTMONK_smtp__*, which is why this is a SQL step.
#   db-post-migrate.sh print-host-script <step>   print what would be sent
#
# Secret values never leave AWS: the host reads them from Secrets Manager with
# its own instance role (base.yaml grants it only the five database secrets)
# and hands them to psql through the environment and \getenv. Neither the SSM command (a base64
# copy of a fixed script, visible in SSM history), its output nor this machine
# ever holds a value. Both steps are idempotent.
#
# Environment: DRY_RUN=1 prints the host script and sends nothing.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq base64

host_script() { # <action>: the bash script the database host runs
  printf 'region=%s\n' "$APP_REGION"
  cat <<'HOST'
set -euo pipefail
cd /
secret() {
  aws secretsmanager get-secret-value --region "$region" --secret-id "postwave/staging/$1" \
    --query SecretString --output text
}
HOST
  case "$1" in
    ops-login)
      cat <<'HOST'
PG_OPS_PW=$(secret db-ops-password)
[ -n "$PG_OPS_PW" ] || { echo "postwave/staging/db-ops-password is empty" >&2; exit 1; }
export PG_OPS_PW
sudo --preserve-env=PG_OPS_PW -u postgres psql -X -q -tA -v ON_ERROR_STOP=1 -d postwave <<'SQL'
\getenv ops_pw PG_OPS_PW
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postwave_ops') THEN
    RAISE EXCEPTION 'role postwave_ops does not exist: run migrate.sh first (migration 1700 creates it)';
  END IF;
END $$;
ALTER ROLE postwave_ops WITH LOGIN PASSWORD :'ops_pw';
SELECT format('postwave_ops: login=%s superuser=%s bypassrls=%s', rolcanlogin, rolsuper, rolbypassrls)
FROM pg_roles WHERE rolname = 'postwave_ops';
SQL
unset PG_OPS_PW
echo "postwave_ops can log in with postwave/staging/db-ops-password"
HOST
      ;;
    listmonk-api-user)
      cat <<'HOST'
LM_TOKEN=$(secret listmonk-admin-password)
[ -n "$LM_TOKEN" ] || { echo "postwave/staging/listmonk-admin-password is empty" >&2; exit 1; }
export LM_TOKEN
sudo --preserve-env=LM_TOKEN -u postgres psql -X -q -tA -v ON_ERROR_STOP=1 -d listmonk <<'SQL'
\getenv token LM_TOKEN
DO $$ BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.roles') IS NULL
     OR to_regclass('public.settings') IS NULL THEN
    RAISE EXCEPTION 'listmonk has not installed its schema yet: start it (DEPLOY_LISTMONK=true deploy.sh services) and wait until it is healthy';
  END IF;
END $$;
INSERT INTO users (username, password_login, password, email, name, type, user_role_id, status)
SELECT 'api', false, :'token', 'api@api', 'api', 'api', r.id, 'enabled'
FROM roles r WHERE r.type = 'user' AND r.name = 'Super Admin'
ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, type = 'api', status = 'enabled';
DO $$ BEGIN
  IF (SELECT count(*) FROM users WHERE username = 'api' AND type = 'api' AND status = 'enabled') <> 1 THEN
    RAISE EXCEPTION 'the listmonk api user was not created (is there a "Super Admin" user role?)';
  END IF;
END $$;
-- Mail listmonk sends itself (campaign sends and test sends, double opt-in
-- confirmations, automation emails: all through /api/tx) uses listmonk's own SMTP,
-- not the API's allow-listed SES role, and a fresh install points that at
-- smtp.yoursite.com:25, a third party. Staging delivers none of it: one SMTP
-- server on the task's own loopback, where nothing listens, so each send
-- fails at once and is logged; and no HTTP postback messengers. Every server
-- disabled is not an option: listmonk v6.1.0 then panics on the first send.
-- LISTMONK_smtp__* variables cannot do this: the database settings override
-- them. The listmonk security group also admits no SMTP egress.
INSERT INTO settings (key, value) VALUES
  ('smtp', '[{"enabled": true, "host": "127.0.0.1", "port": 25, "auth_protocol": "none", "username": "", "password": "", "hello_hostname": "", "max_conns": 1, "idle_timeout": "15s", "wait_timeout": "5s", "max_msg_retries": 0, "tls_type": "none", "tls_skip_verify": false, "email_headers": []}]'),
  ('messengers', '[]')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SELECT format('listmonk smtp: %s', string_agg(format('%s:%s enabled=%s', s->>'host', s->>'port', s->>'enabled'), ', '))
FROM settings, jsonb_array_elements(value) s WHERE key = 'smtp';
SQL
unset LM_TOKEN
echo "listmonk api user ready; listmonk delivers no mail (SMTP on loopback only)"
HOST
      ;;
  esac
}

action="${1:-}"
case "$action" in
  ops-login|listmonk-api-user) ;;
  print-host-script)
    case "${2:-}" in ops-login|listmonk-api-user) host_script "$2"; exit 0 ;; esac
    die "usage: db-post-migrate.sh print-host-script ops-login|listmonk-api-user" ;;
  -h|--help) usage_from_header "$0"; exit 0 ;;
  *) usage_from_header "$0" >&2; exit 2 ;;
esac

step "database host"
base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
status_is_complete "$base_status" || die "$STACK_BASE is $base_status"
require_staging_stack "$APP_REGION" "$STACK_BASE"
instance=$(stack_output "$APP_REGION" "$STACK_BASE" DbInstanceId)
[ -n "$instance" ] || die "$STACK_BASE has no DbInstanceId output"
instance_json=$(awsx "$APP_REGION" ec2 describe-instances --instance-ids "$instance" \
  --query 'Reservations[0].Instances[0]' --output json)
instance_tag=$(printf '%s' "$instance_json" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.Tags // [])[] | select(.Key == $k) | .Value][0] // ""')
require_tagged "instance $instance" "$instance_tag"
instance_state=$(printf '%s' "$instance_json" | jq -r '.State.Name')
[ "$instance_state" = running ] || die "$instance is $instance_state; run resume.sh first"
log "  $instance running"

script=$(host_script "$action")
if is_dry_run; then
  plan "send this script to $instance with SSM AWS-RunShellScript (as root; psql as postgres):"
  printf '%s\n' "$script" | sed 's/^/    /' >&2
  [ "$action" != listmonk-api-user ] || plan "then force a new deployment of postwave-listmonk and wait for it"
  exit 0
fi

ping_deadline=$(( $(now) + 300 ))
while :; do
  ping=$(awsx "$APP_REGION" ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$instance" --query 'InstanceInformationList[0].PingStatus' --output text)
  [ "$ping" != Online ] || break
  [ "$(now)" -lt "$ping_deadline" ] || die "the SSM agent on $instance is not online (${ping:-unknown}) after 5 minutes"
  log "  SSM agent ${ping:-not registered}; waiting"
  sleep 15
done

encoded=$(printf '%s\n' "$script" | base64 | tr -d '\n')
jq -n --arg c "printf '%s' '$encoded' | base64 -d | bash" '{commands: [$c], executionTimeout: ["600"]}' \
  >"$STAGING_TMP/ssm-params.json"
step "running $action on $instance"
command_id=$(awsx "$APP_REGION" ssm send-command --instance-ids "$instance" \
  --document-name AWS-RunShellScript --comment "moosewave-staging db-post-migrate $action" \
  --parameters "file://$STAGING_TMP/ssm-params.json" --timeout-seconds 600 \
  --query Command.CommandId --output text)
log "  command $command_id"
deadline=$(( $(now) + 900 ))
status=Pending
while :; do
  [ "$(now)" -lt "$deadline" ] || die "command $command_id still $status after 15 minutes"
  sleep 5
  if ! awsx_capture "$APP_REGION" ssm get-command-invocation --command-id "$command_id" \
      --instance-id "$instance" --output json >"$STAGING_TMP/invocation.json"; then
    # The invocation appears a moment after send-command returns.
    aws_last_error_matches InvocationDoesNotExist || { aws_last_error_print; die "could not read command $command_id"; }
    continue
  fi
  status=$(jq -r '.Status' "$STAGING_TMP/invocation.json")
  case "$status" in
    Pending|InProgress|Delayed) ;;
    *) break ;;
  esac
done
jq -r '.StandardOutputContent // ""' "$STAGING_TMP/invocation.json" | sed 's/^/  | /' >&2
jq -r '.StandardErrorContent // ""' "$STAGING_TMP/invocation.json" | awk 'NF' | sed 's/^/  ! /' >&2
[ "$status" = Success ] || die "$action ended $status on $instance"

if [ "$action" = listmonk-api-user ]; then
  desired=$(awsx "$APP_REGION" ecs describe-services --cluster "$CLUSTER" --services postwave-listmonk \
    --query 'services[0].desiredCount' --output text)
  if [ "$desired" = 0 ] || [ "$desired" = None ]; then
    log "postwave-listmonk is not running; it reads the token and SMTP settings when it next starts"
  else
    step "restarting postwave-listmonk so it loads the API token and SMTP settings"
    awsx "$APP_REGION" ecs update-service --cluster "$CLUSTER" --service postwave-listmonk \
      --force-new-deployment --query 'service.serviceName' --output text >/dev/null
    awsx "$APP_REGION" ecs wait services-stable --cluster "$CLUSTER" --services postwave-listmonk
    log "  postwave-listmonk is stable"
  fi
fi
log "done"
