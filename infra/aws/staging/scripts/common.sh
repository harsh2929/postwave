# shellcheck shell=bash disable=SC2034 # a library: its constants are used by the scripts that source it
# SPDX-License-Identifier: AGPL-3.0-only
#
# common.sh -- NON-PRODUCTION. Constants and helpers shared by the Moosewave
# lean staging scripts in this directory. Every script sources it; it is never
# run on its own.
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no ${x,,}, no
# mapfile, no GNU-only sed/date/stat flags, and every array that can be empty
# is expanded as ${a[@]+"${a[@]}"}.
#
# Failure policy: errexit, nounset, pipefail and errtrace are on, and the ERR
# trap names the failing command and line. bash does NOT apply errexit inside
# $(...) or inside a function called from `if`, `&&` or `||` (and 3.2 has no
# inherit_errexit), so every helper checks each fallible command itself
# (`|| return 1`) or is a single pipeline whose status pipefail carries out.
# An AWS error therefore always fails the script; it is never read as "absent".
#
# AWS endpoints: the operator's IPv4 path drops full-size packets, so every
# AWS call goes through awsx, which sends each service to its dual-stack
# (IPv6-capable) endpoint: https://<service>.<region>.api.aws for most APIs,
# route53/iam at their *.global.api.aws names, and S3 at
# s3.dualstack.<region>.amazonaws.com. Secrets Manager keeps its standard
# host, which already has IPv6 (its .api.aws name does not resolve), and
# Budgets has no dual-stack host. The CLI-wide use_dualstack_endpoint switch
# is forced OFF for the same Secrets Manager reason. STAGING_AWS_ENDPOINTS=default
# turns the per-service overrides off where the IPv4 path is healthy.
#
# Secrets are never printed, never passed on a command line, and never
# traced: values travel through shell variables and 0600 temp files only.

[ -n "${BASH_VERSION:-}" ] || { echo "the staging scripts need bash" >&2; exit 2; }
set -Eeuo pipefail
umask 077

STAGING_SCRIPTS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
STAGING_DIR=$(dirname "$STAGING_SCRIPTS_DIR")
REPO_ROOT=$(cd "$STAGING_DIR/../../.." && pwd -P)

# ------------------------------------------------------------------ constants
readonly PROJECT_TAG_KEY=Project
readonly PROJECT_TAG_VALUE=moosewave-staging
readonly APP_REGION=us-west-2
readonly SES_REGION=eu-west-1
readonly GLOBAL_REGION=us-east-1
readonly BUILD_REGION=us-east-1
readonly DOMAIN=staging.moosewave.com
readonly PARENT_ZONE_NAME=moosewave.com.
readonly CLUSTER=postwave-staging
readonly SECRET_PREFIX=postwave/staging/
readonly DB_HOST=db.postwave.internal

readonly STACK_COST_GLOBAL=moosewave-staging-cost-global
readonly STACK_COST_REGIONAL=moosewave-staging-cost-regional
readonly STACK_SES=moosewave-staging-ses
readonly STACK_BASE=moosewave-staging-base
readonly STACK_SERVICES=moosewave-staging-services

readonly CODEBUILD_PROJECT=moosewave-staging-images
readonly CODEBUILD_LOG_GROUP=/aws/codebuild/moosewave-staging-images
readonly CODEBUILD_ROLE_NAME=codebuild-docai-role
readonly SOURCE_PREFIX=moosewave-staging-images

# ECR repositories (us-west-2). The names are shared with production's, which
# is why every script checks their Project tag before pushing or deleting.
readonly ECR_REPOS="postwave-api postwave-web postwave-db-migrator postwave-clamav postwave-listmonk"
# ECS services in start order (pause stops them in reverse).
readonly SERVICES_START_ORDER="postwave-clamav postwave-listmonk postwave-api postwave-web"
readonly ZERO_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000

# Every postwave/staging/* secret: <name>|<generator>|<consumers>.
#   hex:N / b64:N    N random bytes, hex or base64 encoded (secrets.sh bootstrap)
#   dsn:USER:SECRET  postgres://USER:<value of SECRET>@db.postwave.internal/...
#   redis-url        rediss://:<redis-auth-token>@<base RedisPrimaryEndpoint>
#   external         a third-party value the operator supplies (secrets.sh put)
# Consumers: base = read by base.yaml (user data, Valkey, the DB host role);
# services = a required services.yaml <Name>SecretArn parameter; optional = an
# optional one. Passwords are hex so every DSN is URL- and key=value-safe; the
# listmonk UI password stays under bcrypt's 72-byte limit.
readonly STAGING_SECRET_SPECS='
db-postgres-password|hex:32|base
db-app-password|hex:32|base
db-ops-password|hex:32|base
redis-auth-token|hex:32|base
listmonk-db-password|hex:32|base,services
listmonk-admin-password|hex:32|base,services
listmonk-ui-admin-password|hex:24|services
auth-hmac-pepper|b64:64|services
api-key-pepper|hex:32|services
consent-cursor-signing-key|hex:32|services
sms-inbox-cursor-key|hex:32|services
helpdesk-cursor-key|hex:32|services
pii-fingerprint-pepper|hex:32|services
subscriber-import-fingerprint-key|hex:32|services
sending-kek|b64:32|services
internal-api-token|hex:32|services
metrics-token|hex:48|services
portal-jwt|hex:32|services
listmonk-webhook|hex:32|services
postmark-hmac|hex:32|services
sendgrid-hmac|hex:32|services
arf-hmac|hex:32|services
shopify-webhook-secret|hex:32|services
archive-views-salt|hex:32|services
db-dsn|dsn:postwave_app:db-app-password|services
ops-db-dsn|dsn:postwave_ops:db-ops-password|services
migration-db-dsn|dsn:postgres:db-postgres-password|services
redis-url|redis-url|services
stripe-secret-key|external|optional
stripe-webhook|external|optional
stripe-price-ltd|external|optional
stripe-price-sending|external|optional
stripe-price-pro|external|optional
dodo-payments-api-key|external|optional
dodo-payments-webhook-key|external|optional
dodo-payments-product-launch-monthly|external|optional
dodo-payments-product-growth-monthly|external|optional
dodo-payments-product-scale-monthly|external|optional
anthropic-api-key|external|optional
ops-slack-webhook-url|external|optional
'

# ---------------------------------------------------------------- environment
STAGING_AWS_BIN=${STAGING_AWS_BIN:-aws}
STAGING_STATE_DIR=${STAGING_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/moosewave-staging}
export AWS_PAGER="" AWS_CLI_AUTO_PROMPT=off AWS_USE_DUALSTACK_ENDPOINT=false
export AWS_RETRY_MODE="${AWS_RETRY_MODE:-standard}" AWS_MAX_ATTEMPTS="${AWS_MAX_ATTEMPTS:-6}"

case "${DRY_RUN:-0}" in 0|1) ;; *) echo "DRY_RUN must be 0 or 1" >&2; exit 2 ;; esac
case "${STAGING_AWS_ENDPOINTS:-dualstack}" in
  dualstack|default) ;;
  *) echo "STAGING_AWS_ENDPOINTS must be dualstack or default" >&2; exit 2 ;;
esac

STAGING_TMP=$(mktemp -d "${TMPDIR:-/tmp}/moosewave-staging.XXXXXX")
staging_cleanup() { rm -rf "$STAGING_TMP"; }
staging_on_err() {
  # Report once, from the top-level shell; a failing $(...) is reported by the
  # assignment that received it.
  [ "${BASH_SUBSHELL:-0}" -eq 0 ] || return 0
  printf 'FAILED (exit %s) at %s line %s: %s\n' "$1" "$(basename "$0")" "$2" "$3" >&2
}
trap staging_cleanup EXIT
trap 'staging_on_err $? $LINENO "$BASH_COMMAND"' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

# -------------------------------------------------------------------- output
log() { printf '%s\n' "$*" >&2; }
step() { printf '\n==> %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
is_dry_run() { [ "${DRY_RUN:-0}" = 1 ]; }
plan() { printf 'DRY-RUN: would %s\n' "$*" >&2; }

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

# Usage text: the comment block after the shebang, up to the first non-comment.
usage_from_header() { # <script path>
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$1"
}

# The templates' AlertEmail pattern: the address lands in an IAM StringLike
# recipient condition, so the IAM wildcards * and ? are refused.
valid_email() { printf '%s' "$1" | grep -Eq '^[^@[:space:]*?]+@[^@[:space:]*?]+\.[^@[:space:]*?]+$'; }

require_alert_email() {
  [ -n "${ALERT_EMAIL:-}" ] || die "set ALERT_EMAIL to the owner address that receives staging alerts"
  valid_email "$ALERT_EMAIL" || die "ALERT_EMAIL is not a plain email address (no spaces, * or ?)"
}

is_bool() { case "$1" in true|false) return 0 ;; *) return 1 ;; esac; }

# Wall clock (seconds since the epoch; BSD and GNU date agree on %s).
now() { date -u +%s; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%S; }

# ----------------------------------------------------------------------- AWS
endpoint_for() { # <cli service> <region>
  [ "${STAGING_AWS_ENDPOINTS:-dualstack}" = dualstack ] || return 0
  case "$1" in
    s3|s3api) printf 'https://s3.dualstack.%s.amazonaws.com' "$2" ;;
    route53) printf 'https://route53.global.api.aws' ;;
    iam) printf 'https://iam.global.api.aws' ;;
    sesv2) printf 'https://email.%s.api.aws' "$2" ;;
    elbv2) printf 'https://elasticloadbalancing.%s.api.aws' "$2" ;;
    resourcegroupstaggingapi) printf 'https://tagging.%s.api.aws' "$2" ;;
    cloudwatch) printf 'https://monitoring.%s.api.aws' "$2" ;;
    cloudformation|ecs|ecr|ec2|logs|ssm|sts|kms|sns|codebuild|ce|dlm|servicediscovery|elasticache|acm|lambda|events|scheduler)
      printf 'https://%s.%s.api.aws' "$1" "$2" ;;
    *) ;; # secretsmanager, budgets, anything else: the CLI default host
  esac
}

awsx() { # <region> <cli service> <args...>
  local region="$1" service="$2" ep
  shift 2
  ep=$(endpoint_for "$service" "$region")
  if [ -n "$ep" ]; then
    "$STAGING_AWS_BIN" --region "$region" --endpoint-url "$ep" "$service" "$@"
  else
    "$STAGING_AWS_BIN" --region "$region" "$service" "$@"
  fi
}

# awsx with stderr kept in $AWS_LAST_ERR_FILE, so the caller can tell "not
# found" from every other failure. Returns the CLI's status.
AWS_LAST_ERR_FILE="$STAGING_TMP/aws-last.err"
awsx_capture() {
  local rc=0
  awsx "$@" 2>"$AWS_LAST_ERR_FILE" || rc=$?
  return "$rc"
}
aws_last_error_matches() { grep -Eq "$1" "$AWS_LAST_ERR_FILE" 2>/dev/null; }
aws_last_error_print() { cat "$AWS_LAST_ERR_FILE" >&2 2>/dev/null || true; }

account_id() { # cached in $STAGING_TMP so $(account_id) calls share it
  local f="$STAGING_TMP/account-id" id
  if [ ! -s "$f" ]; then
    id=$(awsx "$APP_REGION" sts get-caller-identity --query Account --output text) || return 1
    printf '%s' "$id" | grep -Eq '^[0-9]{12}$' || { log "could not read the AWS account id"; return 1; }
    printf '%s\n' "$id" >"$f" || return 1
  fi
  cat "$f"
}

# ------------------------------------------------------------ tag interlock
require_tagged() { # <what> <Project tag value found>
  [ "$2" = "$PROJECT_TAG_VALUE" ] ||
    die "refusing: $1 does not carry $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE (found '${2:-no tag}')"
}

# ------------------------------------------------------------------- stacks
# describe-stacks JSON is cached per run in $STAGING_TMP; stack_refresh drops
# the cache after a change. An absent stack caches as {"Stacks":[]}.
stack_cache_file() { printf '%s/stack.%s.%s.json' "$STAGING_TMP" "$1" "$2"; }
stack_refresh() { rm -f "$(stack_cache_file "$1" "$2")"; }
stack_json() { # <region> <stack>
  local f
  f=$(stack_cache_file "$1" "$2")
  if [ ! -s "$f" ]; then
    if awsx_capture "$1" cloudformation describe-stacks --stack-name "$2" --output json >"$f.tmp"; then
      mv "$f.tmp" "$f" || return 1
    elif aws_last_error_matches 'does not exist'; then
      printf '{"Stacks":[]}\n' >"$f" || return 1
    else
      aws_last_error_print
      log "describe-stacks failed for $2 in $1"
      return 1
    fi
  fi
  cat "$f"
}
stack_status() { stack_json "$1" "$2" | jq -r '.Stacks[0].StackStatus // "NONE"'; }
stack_output() { # <region> <stack> <key>
  stack_json "$1" "$2" | jq -r --arg k "$3" '[(.Stacks[0].Outputs // [])[] | select(.OutputKey == $k) | .OutputValue][0] // ""'
}
stack_param() { # <region> <stack> <key>
  stack_json "$1" "$2" | jq -r --arg k "$3" '[(.Stacks[0].Parameters // [])[] | select(.ParameterKey == $k) | .ParameterValue][0] // ""'
}
stack_tag() { # <region> <stack> <tag key>
  stack_json "$1" "$2" | jq -r --arg k "$3" '[(.Stacks[0].Tags // [])[] | select(.Key == $k) | .Value][0] // ""'
}
stack_description() { stack_json "$1" "$2" | jq -r '.Stacks[0].Description // ""'; }
# Pure: is <status> a stable state whose outputs are real?
status_is_complete() {
  case "$1" in
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE) return 0 ;;
    *) return 1 ;;
  esac
}
# A stack this project owns: tagged, and built from one of these templates.
require_staging_stack() { # <region> <stack>
  local tag description
  tag=$(stack_tag "$1" "$2" "$PROJECT_TAG_KEY") || die "could not read stack $2"
  description=$(stack_description "$1" "$2") || die "could not read stack $2"
  require_tagged "stack $2 ($1)" "$tag"
  case "$description" in
    *NON-PRODUCTION\ Moosewave\ staging*) ;;
    *) die "refusing: stack $2 ($1) was not created from an infra/aws/staging template" ;;
  esac
}

# Records the IDs of a stack's newest events, so wait_stack shows only what
# happens after this point (no dependence on the local clock).
seed_stack_events() { # <region> <stack> <seen file>
  : >"$3" || return 1
  awsx "$1" cloudformation describe-stack-events --stack-name "$2" --max-items 100 \
    --query 'StackEvents[].EventId' --output text 2>/dev/null | tr '\t' '\n' >>"$3" || true
}

# Prints the stack's events that are not in <seen file> yet, oldest first.
# Best effort: a failed read just shows nothing this round.
print_new_stack_events() { # <region> <stack> <seen file>
  local events
  events=$(awsx "$1" cloudformation describe-stack-events --stack-name "$2" \
    --max-items 100 --output json 2>/dev/null) || return 0
  printf '%s' "$events" | jq -r '
    (.StackEvents // []) | reverse | .[] |
    [.EventId, (.Timestamp | .[11:19]), .ResourceStatus, .LogicalResourceId,
     ((.ResourceStatusReason // "-") | gsub("[\\n\\t]"; " "))] | @tsv' 2>/dev/null |
  while IFS="$(printf '\t')" read -r id ts status logical reason; do
    grep -Fxq "$id" "$3" 2>/dev/null && continue
    printf '%s\n' "$id" >>"$3"
    printf '  %s %-30s %-34s %s\n' "$ts" "$status" "$logical" "$reason" >&2
  done
  return 0
}

# Waits for a stack operation, streaming its new events. <goal>: create,
# update or delete. Returns 0 on success, 1 on failure, timeout or read error.
wait_stack() { # <region> <stack> <goal> <seen file>
  local region="$1" stack="$2" goal="$3" seen="$4" status deadline
  deadline=$(( $(now) + ${STACK_WAIT_SECONDS:-5400} ))
  while :; do
    stack_refresh "$region" "$stack"
    status=$(stack_status "$region" "$stack") || { log "could not read the status of $stack"; return 1; }
    print_new_stack_events "$region" "$stack" "$seen"
    case "$goal:$status" in
      create:CREATE_COMPLETE|update:UPDATE_COMPLETE|delete:NONE|delete:DELETE_COMPLETE) return 0 ;;
      *:*ROLLBACK_COMPLETE|*:*_FAILED|create:NONE|update:NONE)
        log "stack $stack ended in $status"
        return 1 ;;
    esac
    if [ "$(now)" -ge "$deadline" ]; then
      log "timed out waiting for $stack (still $status)"
      return 1
    fi
    sleep "${STACK_POLL_SECONDS:-15}"
  done
}

print_stack_outputs() { # <region> <stack>
  local status body
  status=$(stack_status "$1" "$2") || return 1
  body=$(stack_json "$1" "$2" |
    jq -r '(.Stacks[0].Outputs // []) | sort_by(.OutputKey)[] | "  \(.OutputKey) = \(.OutputValue)"') || return 1
  printf 'outputs of %s (%s, %s):\n%s\n' "$2" "$1" "$status" "${body:-  (none)}"
}

# ------------------------------------------------------------------ secrets
secret_id() { printf '%s%s' "$SECRET_PREFIX" "$1"; }

# One list-secrets call (planned deletions included) cached per run.
secrets_json() {
  local f="$STAGING_TMP/secrets.json"
  if [ ! -s "$f" ]; then
    awsx "$APP_REGION" secretsmanager list-secrets --include-planned-deletion \
      --filters "Key=name,Values=$SECRET_PREFIX" --output json >"$f.tmp" || return 1
    mv "$f.tmp" "$f" || return 1
  fi
  cat "$f"
}
secrets_refresh() { rm -f "$STAGING_TMP/secrets.json"; }
secret_state() { # <name> -> active | pending-deletion | absent
  secrets_json | jq -r --arg n "$(secret_id "$1")" '
    [(.SecretList // [])[] | select(.Name == $n)][0] as $s |
    if $s == null then "absent" elif ($s.DeletedDate // null) != null then "pending-deletion" else "active" end'
}
secret_arn() { # <name> -> full ARN of an active secret, or ""
  secrets_json | jq -r --arg n "$(secret_id "$1")" '
    [(.SecretList // [])[] | select(.Name == $n and (.DeletedDate // null) == null) | .ARN][0] // ""'
}
secret_tag() { # <name> -> Project tag value
  secrets_json | jq -r --arg n "$(secret_id "$1")" --arg k "$PROJECT_TAG_KEY" '
    [(.SecretList // [])[] | select(.Name == $n) | (.Tags // [])[] | select(.Key == $k) | .Value][0] // ""'
}
# The value, for use inside $(...) only. Never echo it.
secret_value() { # <name>
  awsx "$APP_REGION" secretsmanager get-secret-value --secret-id "$(secret_id "$1")" \
    --query SecretString --output text
}
secret_names_for() { # <consumer> -> names whose consumer list contains it
  printf '%s\n' "$STAGING_SECRET_SPECS" | awk -F'|' -v c="$1" '
    NF == 3 { n = split($3, parts, ","); for (i = 1; i <= n; i++) if (parts[i] == c) print $1 }'
}
secret_generator() { # <name>
  printf '%s\n' "$STAGING_SECRET_SPECS" | awk -F'|' -v n="$1" 'NF == 3 && $1 == n { print $2 }'
}
# kebab-case secret name -> services.yaml parameter <PascalName>SecretArn.
secret_param_name() {
  printf '%s\n' "$1" | awk -F- '{ for (i = 1; i <= NF; i++) printf "%s%s", toupper(substr($i, 1, 1)), substr($i, 2); print "SecretArn" }'
}

# ------------------------------------------------------------- state files
readonly DIGESTS_FILE_NAME=digests.env
ensure_state_dir() { mkdir -p "$STAGING_STATE_DIR"; }
state_digest() { # <key> -> value from the cumulative digests file, or ""
  local f="$STAGING_STATE_DIR/$DIGESTS_FILE_NAME"
  if [ ! -f "$f" ]; then printf '\n'; return 0; fi
  awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' "$f"
}
# Merges KEY=VALUE lines from <new> into <cumulative>: a key in <new> replaces
# the old line, every other old line is kept, and <new>'s lines go last.
merge_env_file() { # <cumulative> <new>
  local out
  out=$(mktemp "$STAGING_TMP/merge.XXXXXX") || return 1
  if [ -f "$1" ]; then
    awk 'FNR == NR { if ((i = index($0, "=")) > 1) seen[substr($0, 1, i - 1)] = 1; next }
         { if ((i = index($0, "=")) > 1 && !(substr($0, 1, i - 1) in seen)) print }' "$2" "$1" >"$out" || return 1
  fi
  awk 'index($0, "=") > 1' "$2" >>"$out" || return 1
  mv "$out" "$1"
}

# ------------------------------------------------------------------- misc
hosted_zone_id() { # the public moosewave.com zone, verified by exact name
  local id json
  if [ -n "${HOSTED_ZONE_ID:-}" ]; then
    id=${HOSTED_ZONE_ID#/hostedzone/}
    json=$(awsx "$GLOBAL_REGION" route53 get-hosted-zone --id "$id" --output json) || return 1
    printf '%s' "$json" | jq -e --arg n "$PARENT_ZONE_NAME" \
      '.HostedZone.Name == $n and (.HostedZone.Config.PrivateZone | not)' >/dev/null ||
      { log "HOSTED_ZONE_ID is not the public $PARENT_ZONE_NAME zone"; return 1; }
    printf '%s\n' "$id"
    return 0
  fi
  # list-hosted-zones-by-name starts AT the name and continues alphabetically,
  # so the first zone returned can be another domain entirely: filter by the
  # exact name and require exactly one public match.
  json=$(awsx "$GLOBAL_REGION" route53 list-hosted-zones-by-name --dns-name "$PARENT_ZONE_NAME" \
    --max-items 20 --output json) || return 1
  id=$(printf '%s' "$json" | jq -r --arg n "$PARENT_ZONE_NAME" '
    [.HostedZones[] | select(.Name == $n and (.Config.PrivateZone | not)) | .Id] |
    if length == 1 then .[0] else "" end') || return 1
  [ -n "$id" ] || { log "found no single public $PARENT_ZONE_NAME hosted zone; set HOSTED_ZONE_ID"; return 1; }
  printf '%s\n' "${id#/hostedzone/}"
}

confirm_phrase() { # <phrase>: proceed only after the operator types it
  local answer=""
  if [ "${CONFIRM:-}" = "$1" ]; then return 0; fi
  [ -r /dev/tty ] || die "not interactive; set CONFIRM=$1 to proceed"
  printf 'Type "%s" to continue: ' "$1" >/dev/tty
  IFS= read -r answer </dev/tty || true
  [ "$answer" = "$1" ] || die "not confirmed"
}
