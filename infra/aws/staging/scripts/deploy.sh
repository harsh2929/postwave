#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# deploy.sh -- NON-PRODUCTION. Creates or updates the Moosewave staging
# CloudFormation stacks, in order, through change sets.
#
#   deploy.sh [all]           every step below, in this order
#   deploy.sh <step>...       only the named steps, in the order given:
#     cost-global     moosewave-staging-cost-global    us-east-1
#     cost-regional   moosewave-staging-cost-regional  us-west-2
#     ses             moosewave-staging-ses            eu-west-1
#     base            moosewave-staging-base           us-west-2
#     services        moosewave-staging-services       us-west-2
#   deploy.sh status          every stack's status and outputs
#
# `all` runs cost-global, cost-regional, ses and base, then writes the
# redis-url secret (secrets.sh redis-url), redeploys cost-regional with base's
# resource ids (arming its ALB, database and Valkey alarms) and ends with
# services. The services step always refreshes redis-url first.
#
# Every step reads the stack, builds its parameters (anything not given keeps
# its previous value), creates a change set through the IPv6 CloudFormation
# endpoint, prints the changes, and refuses to replace or remove a stateful
# resource (DbInstance, Valkey, the buckets, the KMS keys, the Cloud Map
# namespace, the SES identity and configuration set) unless
# ALLOW_REPLACEMENT=1. Then it executes the change set, streams stack events
# until the operation ends, and prints the stack outputs. A change set with no
# changes is deleted and reported as "no changes", so rerunning is safe.
#
# Environment (owner data comes from here, never from the repository):
#   ALERT_EMAIL             required: budget, alarm and OPS_ALERT_EMAIL recipient
#   HOSTED_ZONE_ID          public moosewave.com zone (default: found by exact name)
#   DEPLOY_CLAMAV DEPLOY_LISTMONK DEPLOY_API DEPLOY_WEB
#                           true|false: that service runs 1 task or 0
#                           (default: unchanged; false on first create)
#   API_IMAGE_DIGEST WEB_IMAGE_DIGEST MIGRATOR_IMAGE_DIGEST CLAMAV_IMAGE_DIGEST
#   LISTMONK_IMAGE_DIGEST WEB_RELEASE
#                           override what build-images.sh recorded in the state dir
#   KEEP_IMAGES=1           keep the deployed image digests
#   SES_API_SUBSCRIBE       1: subscribe the SES topics to the API (it must be
#                           ready); 0: remove the subscriptions (default: unchanged)
#   LISTMONK_TEMPLATE_ID    listmonk transactional template id (default: unchanged)
#   ENABLE_CAMPAIGN_LIVE_DISPATCH  true|false (default: unchanged, false on create)
#   DB_INSTANCE_TYPE VALKEY_ENGINE_VERSION  base.yaml sizing (default: unchanged)
#   PROJECT_TAG_ACTIVE      true|false (default: read once from Cost Explorer, $0.01)
#   ALLOW_REPLACEMENT=1     allow a change set to replace/remove a stateful resource
#   DRY_RUN=1               print the plan and parameters; call no write API
#   STAGING_STATE_DIR       where build-images.sh records digests
#                           (default ~/.local/state/moosewave-staging)

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq curl

readonly PROTECTED_RESOURCES=" DbInstance Valkey UploadsBucket AssetsBucket ExportsBucket AppDataKey S3Key Namespace Identity ConfigurationSet "
readonly TEMPLATE_BODY_LIMIT=51200
readonly SES_EVENTS_URL="https://api.$DOMAIN/api/internal/webhooks/deliverability/ses"

# A prerequisite that a real run cannot continue without. A dry run reports it
# and carries on with placeholders, so the whole plan is still shown.
need() {
  if is_dry_run; then warn "a real run would stop here: $*"; return 0; fi
  die "$*"
}
pending() { printf '<pending: %s>' "$*"; }

# ------------------------------------------------------------ parameter files
params_new() { printf '[]\n' >"$1"; }
param_set() { # <file> <key> <value>
  jq --arg k "$2" --arg v "$3" '. + [{ParameterKey: $k, ParameterValue: $v}]' "$1" >"$1.tmp" || return 1
  mv "$1.tmp" "$1"
}
param_keep() { # <file> <key>
  jq --arg k "$2" '. + [{ParameterKey: $k, UsePreviousValue: true}]' "$1" >"$1.tmp" || return 1
  mv "$1.tmp" "$1"
}
# <value> when given; otherwise the previous value of an existing stack;
# otherwise (first create) the template default.
param_value_or_keep() { # <file> <key> <value> <stack exists: 1|0>
  if [ -n "$3" ]; then param_set "$1" "$2" "$3"
  elif [ "$4" = 1 ]; then param_keep "$1" "$2"
  fi
}
print_params() { # <file>: the owner address is shown by name, not value
  jq -r '.[] | "  \(.ParameterKey) = \(
    if .UsePreviousValue then "(unchanged)"
    elif .ParameterKey == "AlertEmail" then "(ALERT_EMAIL)"
    else .ParameterValue end)"' "$1" >&2
}

stack_exists_flag() { # <status> -> 1 when UsePreviousValue is possible
  case "$1" in NONE|REVIEW_IN_PROGRESS) echo 0 ;; *) echo 1 ;; esac
}

# ------------------------------------------------------------------ deploying
change_set_json() { # <region> <change set arn>: every page merged
  local token="" all="$STAGING_TMP/cs-all.json" part="$STAGING_TMP/cs-page.json"
  printf '{"Changes":[]}\n' >"$all"
  while :; do
    if [ -n "$token" ]; then
      awsx "$1" cloudformation describe-change-set --change-set-name "$2" --next-token "$token" --output json >"$part" || return 1
    else
      awsx "$1" cloudformation describe-change-set --change-set-name "$2" --output json >"$part" || return 1
    fi
    jq -s '.[0] as $all | .[1] as $p | $all + ($p | del(.Changes)) | .Changes = ($all.Changes + ($p.Changes // []))' \
      "$all" "$part" >"$all.tmp" || return 1
    mv "$all.tmp" "$all" || return 1
    token=$(jq -r '.NextToken // ""' "$part") || return 1
    [ -n "$token" ] || break
  done
  cat "$all"
}

wait_change_set() { # <region> <change set arn> -> CREATE_COMPLETE | FAILED
  local status deadline
  deadline=$(( $(now) + 900 ))
  while :; do
    status=$(awsx "$1" cloudformation describe-change-set --change-set-name "$2" \
      --query Status --output text) || return 1
    case "$status" in
      CREATE_COMPLETE|FAILED) printf '%s\n' "$status"; return 0 ;;
    esac
    [ "$(now)" -lt "$deadline" ] || { log "change set still $status after 15 minutes"; return 1; }
    sleep 5
  done
}

deploy_stack() { # <region> <stack> <template file name> <params file>
  local region="$1" stack="$2" template="$STAGING_DIR/$3" params="$4"
  local size status type goal seen name arn cs result reason blocked keys key given existing
  size=$(wc -c <"$template" | tr -d ' ')
  [ "$size" -le "$TEMPLATE_BODY_LIMIT" ] ||
    die "$3 is $size bytes, over CloudFormation's $TEMPLATE_BODY_LIMIT-byte inline limit"
  status=$(stack_status "$region" "$stack")
  case "$status" in
    NONE|REVIEW_IN_PROGRESS) type=CREATE; goal=create ;;
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE|IMPORT_ROLLBACK_COMPLETE)
      type=UPDATE; goal=update
      require_staging_stack "$region" "$stack" ;;
    ROLLBACK_COMPLETE)
      die "$stack is ROLLBACK_COMPLETE: its first create failed and it cannot be updated. Read its events, delete it (teardown.sh stack $stack), then deploy again." ;;
    *_IN_PROGRESS) die "$stack is busy ($status); wait for it to finish, then rerun" ;;
    *) die "$stack is $status; resolve that by hand before deploying" ;;
  esac
  keys=$(awsx "$region" cloudformation validate-template --template-body "file://$template" \
    --query 'Parameters[].ParameterKey' --output text)
  # An update that leaves a parameter out RESETS it to the template default,
  # so every parameter this run does not set keeps its previous value (what
  # `aws cloudformation deploy` does), when the stack has it and the template
  # still declares it.
  if [ "$type" = UPDATE ]; then
    for key in $keys; do
      given=$(jq --arg k "$key" 'any(.[]; .ParameterKey == $k)' "$params")
      existing=$(stack_json "$region" "$stack" | jq --arg k "$key" 'any((.Stacks[0].Parameters // [])[]; .ParameterKey == $k)')
      if [ "$given" = false ] && [ "$existing" = true ]; then param_keep "$params" "$key"; fi
    done
  fi
  step "$stack ($region): $type from $3 ($size bytes)"
  print_params "$params"
  if is_dry_run; then
    log "  template validates"
    plan "create a $type change set for $stack in $region, show it, execute it and wait"
    return 0
  fi
  seen="$STAGING_TMP/events.$region.$stack"
  name="moosewave-staging-$(date -u +%Y%m%d%H%M%S)"
  arn=$(awsx "$region" cloudformation create-change-set --stack-name "$stack" \
    --change-set-name "$name" --change-set-type "$type" \
    --template-body "file://$template" --parameters "file://$params" \
    --capabilities CAPABILITY_IAM \
    --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
    --description "deploy.sh $type $(iso_now)Z" \
    --query Id --output text)
  result=$(wait_change_set "$region" "$arn")
  cs=$(change_set_json "$region" "$arn")
  if [ "$result" = FAILED ]; then
    reason=$(printf '%s' "$cs" | jq -r '.StatusReason // ""')
    case "$reason" in
      *"didn't contain changes"*|*"No updates are to be performed"*)
        awsx "$region" cloudformation delete-change-set --change-set-name "$arn"
        log "  no changes"
        stack_refresh "$region" "$stack"
        print_stack_outputs "$region" "$stack"
        return 0 ;;
    esac
    die "change set for $stack failed: $reason"
  fi
  log "  changes:"
  printf '%s' "$cs" | jq -r '.Changes[].ResourceChange |
    "    \(.Action) \(.LogicalResourceId) (\(.ResourceType))\(if .Replacement and .Replacement != "False" then " replacement=\(.Replacement)" else "" end)"' >&2
  blocked=$(printf '%s' "$cs" | jq -r --arg p "$PROTECTED_RESOURCES" '
    .Changes[].ResourceChange | . as $c | $c.LogicalResourceId as $id |
    select(($p | contains(" " + $id + " ")) and
           ($c.Action == "Remove" or $c.Replacement == "True" or $c.Replacement == "Conditional")) |
    "\($id) (\($c.Action), replacement=\($c.Replacement // "n/a"))"')
  if [ -n "$blocked" ] && [ "${ALLOW_REPLACEMENT:-0}" != 1 ]; then
    awsx "$region" cloudformation delete-change-set --change-set-name "$arn"
    die "refusing: this change would replace or remove stateful resources (their data goes with them): $(printf '%s' "$blocked" | tr '\n' ' ')- rerun with ALLOW_REPLACEMENT=1 only if that is intended"
  fi
  seed_stack_events "$region" "$stack" "$seen"
  awsx "$region" cloudformation execute-change-set --change-set-name "$arn"
  log "  executing; events:"
  wait_stack "$region" "$stack" "$goal" "$seen" || die "$stack did not reach ${goal}d state; the events above say why"
  stack_refresh "$region" "$stack"
  print_stack_outputs "$region" "$stack"
}

# ------------------------------------------------------------- shared inputs
project_tag_active() { # -> true|false (cached per run)
  local f="$STAGING_TMP/project-tag-active" status
  if [ -n "${PROJECT_TAG_ACTIVE:-}" ]; then
    is_bool "$PROJECT_TAG_ACTIVE" || { log "PROJECT_TAG_ACTIVE must be true or false"; return 1; }
    printf '%s\n' "$PROJECT_TAG_ACTIVE"
    return 0
  fi
  if [ ! -s "$f" ]; then
    if is_dry_run; then
      plan "read the Project cost allocation tag status from Cost Explorer (one \$0.01 request); assuming active"
      echo true >"$f"
    else
      status=$(awsx "$GLOBAL_REGION" ce list-cost-allocation-tags --tag-keys "$PROJECT_TAG_KEY" \
        --type UserDefined --query 'CostAllocationTags[0].Status' --output text) || return 1
      if [ "$status" = Active ]; then echo true >"$f"
      else
        warn "the $PROJECT_TAG_KEY cost allocation tag is '$status', so the budgets fall back to Region=$APP_REGION and the anomaly monitor is skipped; activate it with: aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=$PROJECT_TAG_KEY,Status=Active"
        echo false >"$f"
      fi
    fi
  fi
  cat "$f"
}

zone_for_create() {
  local zone
  zone=$(hosted_zone_id) || return 1
  printf '%s\n' "$zone"
}

# The previous HostedZoneId stays; a different HOSTED_ZONE_ID is a mistake.
check_zone_unchanged() { # <region> <stack>
  local previous
  [ -n "${HOSTED_ZONE_ID:-}" ] || return 0
  previous=$(stack_param "$1" "$2" HostedZoneId) || return 1
  [ "$previous" = "${HOSTED_ZONE_ID#/hostedzone/}" ] ||
    die "$2 uses hosted zone $previous; HOSTED_ZONE_ID=$HOSTED_ZONE_ID differs (the zone never changes)"
}

# ---------------------------------------------------------------------- steps
deploy_cost_global() {
  local p="$STAGING_TMP/params.cost-global.json" active
  require_alert_email
  active=$(project_tag_active)
  params_new "$p"
  param_set "$p" AlertEmail "$ALERT_EMAIL"
  param_set "$p" ProjectTagActive "$active"
  deploy_stack "$GLOBAL_REGION" "$STACK_COST_GLOBAL" cost-guard-global.yaml "$p"
}

deploy_cost_regional() {
  local p="$STAGING_TMP/params.cost-regional.json" active status exists base_status key value
  require_alert_email
  active=$(project_tag_active)
  status=$(stack_status "$APP_REGION" "$STACK_COST_REGIONAL")
  exists=$(stack_exists_flag "$status")
  stack_refresh "$APP_REGION" "$STACK_BASE"
  base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
  params_new "$p"
  param_set "$p" AlertEmail "$ALERT_EMAIL"
  param_set "$p" ProjectTagActive "$active"
  # Resource-id alarms follow base: its ids when it has them, none when it
  # is gone (so a torn-down base leaves no orphaned alarms behind).
  for key in AlbFullName DbInstanceId CacheClusterId; do
    value=$(stack_output "$APP_REGION" "$STACK_BASE" "$key")
    if [ -n "$value" ]; then param_set "$p" "$key" "$value"
    elif [ "$base_status" = NONE ]; then param_set "$p" "$key" ""
    else param_value_or_keep "$p" "$key" "" "$exists"
    fi
  done
  deploy_stack "$APP_REGION" "$STACK_COST_REGIONAL" cost-guard-regional.yaml "$p"
}

deploy_ses() {
  local p="$STAGING_TMP/params.ses.json" status exists ready zone
  status=$(stack_status "$SES_REGION" "$STACK_SES")
  exists=$(stack_exists_flag "$status")
  params_new "$p"
  if [ "$exists" = 1 ]; then
    check_zone_unchanged "$SES_REGION" "$STACK_SES"
    param_keep "$p" HostedZoneId
  else
    zone=$(zone_for_create)
    param_set "$p" HostedZoneId "$zone"
  fi
  case "${SES_API_SUBSCRIBE:-}" in
    1)
      # SNS sends one SubscriptionConfirmation when the subscription is made;
      # if the API cannot receive it, the subscription is stranded.
      if is_dry_run; then
        plan "check https://api.$DOMAIN/api/ready answers 200 before subscribing"
      else
        ready=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://api.$DOMAIN/api/ready" || true)
        [ "$ready" = 200 ] || die "the API is not ready (GET /api/ready gave ${ready:-no answer}); subscribe once smoke.sh api passes"
      fi
      param_set "$p" ApiEventsEndpoint "$SES_EVENTS_URL" ;;
    0) param_set "$p" ApiEventsEndpoint "" ;;
    "") param_value_or_keep "$p" ApiEventsEndpoint "" "$exists" ;;
    *) die "SES_API_SUBSCRIBE must be 1 or 0" ;;
  esac
  deploy_stack "$SES_REGION" "$STACK_SES" ses.yaml "$p"
  if [ "${SES_API_SUBSCRIBE:-}" = 1 ] && ! is_dry_run; then
    log "confirm both subscriptions: the API logs each SubscribeURL (CloudWatch /ecs/postwave-staging/api); open each within 3 days, then check: aws sns list-subscriptions-by-topic --region $SES_REGION --topic-arn <topic>"
  fi
}

deploy_base() {
  local p="$STAGING_TMP/params.base.json" status exists name state missing="" vpc cidr subnet_a subnet_b ami zone
  require_alert_email
  for name in $(secret_names_for base); do
    state=$(secret_state "$name")
    [ "$state" = active ] || missing="$missing $name"
  done
  [ -z "$missing" ] || need "base.yaml reads secrets that do not exist yet:$missing (run secrets.sh bootstrap)"
  status=$(stack_status "$APP_REGION" "$STACK_BASE")
  exists=$(stack_exists_flag "$status")
  params_new "$p"
  if [ "$exists" = 1 ]; then
    check_zone_unchanged "$APP_REGION" "$STACK_BASE"
    for name in HostedZoneId VpcId VpcCidr SubnetIdA SubnetIdB; do param_keep "$p" "$name"; done
    # A new AMI id would REPLACE the database instance and its data.
    param_value_or_keep "$p" DbImageId "${DB_IMAGE_ID:-}" 1
  else
    zone=$(zone_for_create)
    param_set "$p" HostedZoneId "$zone"
    vpc=$(awsx "$APP_REGION" ec2 describe-vpcs --filters Name=isDefault,Values=true \
      --query 'Vpcs[0].VpcId' --output text)
    [ -n "$vpc" ] && [ "$vpc" != None ] || die "no default VPC in $APP_REGION"
    cidr=$(awsx "$APP_REGION" ec2 describe-vpcs --vpc-ids "$vpc" --query 'Vpcs[0].CidrBlock' --output text)
    subnet_a=$(default_subnet "$vpc" "${APP_REGION}a")
    subnet_b=$(default_subnet "$vpc" "${APP_REGION}b")
    ami=${DB_IMAGE_ID:-$(awsx "$APP_REGION" ssm get-parameter \
      --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
      --query Parameter.Value --output text)}
    printf '%s' "$ami" | grep -Eq '^ami-[0-9a-f]{8,17}$' || die "could not resolve the AL2023 arm64 AMI"
    param_set "$p" VpcId "$vpc"
    param_set "$p" VpcCidr "$cidr"
    param_set "$p" SubnetIdA "$subnet_a"
    param_set "$p" SubnetIdB "$subnet_b"
    param_set "$p" DbImageId "$ami"
  fi
  param_set "$p" AlertEmail "$ALERT_EMAIL"
  param_value_or_keep "$p" DbInstanceType "${DB_INSTANCE_TYPE:-}" "$exists"
  param_value_or_keep "$p" ValkeyEngineVersion "${VALKEY_ENGINE_VERSION:-}" "$exists"
  deploy_stack "$APP_REGION" "$STACK_BASE" base.yaml "$p"
}

default_subnet() { # <vpc> <az>
  local id
  id=$(awsx "$APP_REGION" ec2 describe-subnets --filters "Name=vpc-id,Values=$1" \
    "Name=availability-zone,Values=$2" Name=default-for-az,Values=true \
    --query 'Subnets[0].SubnetId' --output text) || return 1
  [ -n "$id" ] && [ "$id" != None ] || { log "no default subnet in $2"; return 1; }
  printf '%s\n' "$id"
}

ensure_redis_url() {
  local base_status
  stack_refresh "$APP_REGION" "$STACK_BASE"
  base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
  if ! status_is_complete "$base_status"; then
    need "redis-url needs $STACK_BASE (it is $base_status)"
    is_dry_run && plan "write postwave/staging/redis-url once base exists (secrets.sh redis-url)"
    return 0
  fi
  DRY_RUN="${DRY_RUN:-0}" "$STAGING_SCRIPTS_DIR/secrets.sh" redis-url
  secrets_refresh
}

# <param> <state digests key> <env override> [fallback state key]
image_param() {
  local p="$1" key="$2" override="$3" fallback="${4:-}" exists="$5" value previous
  value=$override
  if [ -z "$value" ] && [ "${KEEP_IMAGES:-0}" != 1 ]; then
    value=$(state_digest "$key")
    if [ -z "$value" ] && [ -n "$fallback" ]; then
      value=$(state_digest "$fallback")
      [ -z "$value" ] || warn "no $key image recorded; using the $fallback image (MJML rendering will fail in production mode)"
    fi
  fi
  if [ -n "$value" ]; then
    case "$key" in
      *.release) printf '%s' "$value" | grep -Eq '^[0-9a-f]{40}$' || die "$p must be a 40-hex commit (got '$value')" ;;
      *) printf '%s' "$value" | grep -Eq '^sha256:[0-9a-f]{64}$' || die "$p must be sha256:<64 hex> (got '$value')" ;;
    esac
    if [ "$exists" = 1 ]; then
      previous=$(stack_param "$APP_REGION" "$STACK_SERVICES" "$p")
      [ "$previous" = "$value" ] || log "  $p: ${previous:-unset} -> $value"
    fi
  fi
  param_value_or_keep "$PARAMS_FILE" "$p" "$value" "$exists"
}

flag_param() { # <param> <env value> <exists>
  if [ -n "$2" ]; then
    is_bool "$2" || die "$1 must be true or false (got '$2')"
    param_set "$PARAMS_FILE" "$1" "$2"
  elif [ "$3" = 1 ]; then
    param_keep "$PARAMS_FILE" "$1"
  else
    param_set "$PARAMS_FILE" "$1" false
  fi
}

deploy_services() {
  local status exists base_status ses_status name state arn missing="" topics subnets cidrs
  local stripe_count=0 stripe_total=0 dodo_count=0 dodo_total=0
  require_alert_email
  PARAMS_FILE="$STAGING_TMP/params.services.json"
  stack_refresh "$APP_REGION" "$STACK_BASE"
  base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
  status_is_complete "$base_status" || need "services.yaml imports $STACK_BASE, which is $base_status"
  ses_status=$(stack_status "$SES_REGION" "$STACK_SES")
  status_is_complete "$ses_status" || need "services.yaml needs $STACK_SES's topic ARNs ($STACK_SES is $ses_status)"
  ensure_redis_url
  status=$(stack_status "$APP_REGION" "$STACK_SERVICES")
  exists=$(stack_exists_flag "$status")
  params_new "$PARAMS_FILE"
  param_set "$PARAMS_FILE" AlertEmail "$ALERT_EMAIL"

  topics=$(stack_output "$SES_REGION" "$STACK_SES" SesTopicArns)
  param_set "$PARAMS_FILE" SesTopicArns "${topics:-$(pending "$STACK_SES output SesTopicArns")}"

  subnets=$(stack_output "$APP_REGION" "$STACK_BASE" TaskSubnetIds)
  if [ -n "$subnets" ]; then
    # The ALB and the tasks share these two subnets; the API admits only the
    # ALB security group, so no other host there can spoof X-Forwarded-For.
    cidrs=$(awsx "$APP_REGION" ec2 describe-subnets --subnet-ids "${subnets%%,*}" "${subnets#*,}" --output json |
      jq -r --arg a "${subnets%%,*}" --arg b "${subnets#*,}" '
        [.Subnets[] | {(.SubnetId): .CidrBlock}] | add | "\(.[$a]),\(.[$b])"')
    param_set "$PARAMS_FILE" TrustedProxyCidrs "$cidrs"
  else
    param_set "$PARAMS_FILE" TrustedProxyCidrs "$(pending "$STACK_BASE subnet CIDRs")"
  fi

  secrets_refresh
  for name in $(secret_names_for services); do
    arn=$(secret_arn "$name")
    if [ -z "$arn" ]; then
      missing="$missing $name"
      arn=$(pending "postwave/staging/$name")
    fi
    param_set "$PARAMS_FILE" "$(secret_param_name "$name")" "$arn"
  done
  [ -z "$missing" ] || need "services.yaml needs secrets that do not exist:$missing (secrets.sh bootstrap; redis-url comes after base)"
  for name in $(secret_names_for optional); do
    arn=$(secret_arn "$name")
    case "$name" in
      stripe-*) stripe_total=$((stripe_total + 1)); [ -z "$arn" ] || stripe_count=$((stripe_count + 1)) ;;
      dodo-payments-*) dodo_total=$((dodo_total + 1)); [ -z "$arn" ] || dodo_count=$((dodo_count + 1)) ;;
    esac
    param_set "$PARAMS_FILE" "$(secret_param_name "$name")" "$arn"
  done
  [ "$stripe_count" -eq 0 ] || [ "$stripe_count" -eq "$stripe_total" ] ||
    die "Stripe needs all $stripe_total postwave/staging/stripe-* secrets; $stripe_count exist (secrets.sh put ...)"
  [ "$dodo_count" -eq 0 ] || [ "$dodo_count" -eq "$dodo_total" ] ||
    die "Dodo Payments needs all $dodo_total postwave/staging/dodo-payments-* secrets; $dodo_count exist (secrets.sh put ...)"

  image_param ApiImageDigest api-mjml "${API_IMAGE_DIGEST:-}" api "$exists"
  image_param WebImageDigest web "${WEB_IMAGE_DIGEST:-}" "" "$exists"
  image_param ReleaseId web.release "${WEB_RELEASE:-}" "" "$exists"
  image_param MigratorImageDigest db-migrator "${MIGRATOR_IMAGE_DIGEST:-}" "" "$exists"
  image_param ClamavImageDigest clamav "${CLAMAV_IMAGE_DIGEST:-}" "" "$exists"
  image_param ListmonkImageDigest listmonk "${LISTMONK_IMAGE_DIGEST:-}" "" "$exists"

  flag_param DeployClamav "${DEPLOY_CLAMAV:-}" "$exists"
  flag_param DeployListmonk "${DEPLOY_LISTMONK:-}" "$exists"
  flag_param DeployApi "${DEPLOY_API:-}" "$exists"
  flag_param DeployWeb "${DEPLOY_WEB:-}" "$exists"
  param_value_or_keep "$PARAMS_FILE" ListmonkDefaultTemplateId "${LISTMONK_TEMPLATE_ID:-}" "$exists"
  # BillingLaunchApproval was added after the first staging stack revision.
  # UsePreviousValue is invalid for a parameter that the live stack has never
  # seen, so leave a new, intentionally-unset parameter out and let
  # CloudFormation apply the template's safe empty default. Once the stack has
  # the parameter, preserve it on ordinary web/API deploys as usual.
  if [ -n "${BILLING_LAUNCH_APPROVAL:-}" ]; then
    param_set "$PARAMS_FILE" BillingLaunchApproval "$BILLING_LAUNCH_APPROVAL"
  elif [ "$exists" = 1 ] && stack_json "$APP_REGION" "$STACK_SERVICES" |
      jq -e 'any((.Stacks[0].Parameters // [])[]; .ParameterKey == "BillingLaunchApproval")' >/dev/null; then
    param_keep "$PARAMS_FILE" BillingLaunchApproval
  fi
  if [ -n "${ENABLE_CAMPAIGN_LIVE_DISPATCH:-}" ]; then
    is_bool "$ENABLE_CAMPAIGN_LIVE_DISPATCH" || die "ENABLE_CAMPAIGN_LIVE_DISPATCH must be true or false"
  fi
  param_value_or_keep "$PARAMS_FILE" EnableCampaignLiveDispatch "${ENABLE_CAMPAIGN_LIVE_DISPATCH:-}" "$exists"

  deploy_stack "$APP_REGION" "$STACK_SERVICES" services.yaml "$PARAMS_FILE"
  if ! is_dry_run; then
    log "service state: $(stack_output "$APP_REGION" "$STACK_SERVICES" DeployState)"
  fi
}

show_status() {
  local entry region stack
  for entry in "$GLOBAL_REGION:$STACK_COST_GLOBAL" "$APP_REGION:$STACK_COST_REGIONAL" \
      "$SES_REGION:$STACK_SES" "$APP_REGION:$STACK_BASE" "$APP_REGION:$STACK_SERVICES"; do
    region=${entry%%:*}; stack=${entry#*:}
    print_stack_outputs "$region" "$stack"
  done
}

# ----------------------------------------------------------------------- main
[ $# -gt 0 ] || set -- all
for arg in "$@"; do
  case "$arg" in
    all|cost-global|cost-regional|ses|base|services|status) ;;
    -h|--help|help) usage_from_header "$0"; exit 0 ;;
    *) usage_from_header "$0" >&2; die "unknown step: $arg" ;;
  esac
done
is_dry_run && log "DRY_RUN=1: reading only; no change set is created or executed"
ACCOUNT=$(account_id)
log "account $ACCOUNT; state dir $STAGING_STATE_DIR"
for arg in "$@"; do
  case "$arg" in
    all)
      deploy_cost_global
      deploy_cost_regional
      deploy_ses
      deploy_base
      ensure_redis_url
      step "re-arming the resource-id alarms with base's outputs"
      deploy_cost_regional
      deploy_services ;;
    cost-global) deploy_cost_global ;;
    cost-regional) deploy_cost_regional ;;
    ses) deploy_ses ;;
    base) deploy_base ;;
    services) deploy_services ;;
    status) show_status ;;
  esac
done
log "done"
