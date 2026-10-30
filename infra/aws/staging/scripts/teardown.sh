#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# teardown.sh -- NON-PRODUCTION. Deletes the Moosewave staging environment.
#
#   teardown.sh [all]          everything except the cost guard
#   teardown.sh cost-guard     later: the two cost-guard stacks
#   teardown.sh stack <name>   one staging stack, e.g. a first create that
#                              ended ROLLBACK_COMPLETE
#
# Tag-interlocked. It first inventories every resource it would delete and
# checks that each carries Project=moosewave-staging (a stack must also come
# from an infra/aws/staging template). If ANY item fails, it stops before
# deleting anything and lists the offenders; each item is checked again
# right before it is deleted. Route 53 records carry no tags, so the only
# records it removes itself are leftover ACM validation CNAMEs: name
# _<hash>.staging.moosewave.com, value *.acm-validations.aws., and only when
# no ACM certificate for staging.moosewave.com remains. Nothing else in the
# moosewave.com zone is ever touched, and the zone itself never.
#
# Order (all): stray tasks started outside the services (stopped) ->
# moosewave-staging-services -> the three staging buckets (emptied, every
# version) -> moosewave-staging-base (its KMS keys enter a 7-day pending
# deletion; log groups, DNS aliases, Valkey and the database go with it) ->
# leftover ACM validation CNAMEs -> the database volume's DLM snapshots ->
# moosewave-staging-ses (eu-west-1, with its DKIM records) -> the five ECR
# repositories and their images -> every postwave/staging/* secret (7-day
# recovery window; FORCE_DELETE_SECRETS=1 deletes at once) -> CodeBuild
# project moosewave-staging-images, its log group, and this project's objects
# in the CodeBuild source bucket. Last, it lists whatever still carries the
# tag in us-west-2, eu-west-1 and us-east-1.
#
# The cost guard (budgets, anomaly monitor, alarms, daily digest) stays so the
# bill can be watched reaching zero; remove it with `teardown.sh cost-guard`
# once the digest has shown $0.00 for two days.
#
# Environment: CONFIRM=<phrase> answers the typed confirmation
# (moosewave-staging, or the stack name for `stack`); DRY_RUN=1 runs the
# inventory and every interlock check and deletes nothing.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq

readonly CONFIRM_PHRASE=moosewave-staging
readonly ACM_RECORD_PATTERN='^_[0-9a-f]+\.(\*\.)?staging\.moosewave\.com\.$'
PLAN="$STAGING_TMP/plan.txt"
PROBLEMS="$STAGING_TMP/problems.txt"
: >"$PLAN"
: >"$PROBLEMS"

planned() { printf '  %-18s %s\n' "$1" "$2" >>"$PLAN"; }
problem() { printf '  %s\n' "$*" >>"$PROBLEMS"; }
tag_check() { # <what> <tag value>: record a problem unless it is the staging tag
  [ "$2" = "$PROJECT_TAG_VALUE" ] || problem "$1 does not carry $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE (found '${2:-no tag}')"
}
stack_check() { # <region> <stack>: record problems for a stack that is not ours
  local tag description
  tag=$(stack_tag "$1" "$2" "$PROJECT_TAG_KEY") || return 1
  description=$(stack_description "$1" "$2") || return 1
  tag_check "stack $2 ($1)" "$tag"
  case "$description" in
    *NON-PRODUCTION\ Moosewave\ staging*) ;;
    *) problem "stack $2 ($1) was not created from an infra/aws/staging template" ;;
  esac
}
stack_region() {
  case "$1" in
    "$STACK_COST_GLOBAL") echo "$GLOBAL_REGION" ;;
    "$STACK_SES") echo "$SES_REGION" ;;
    "$STACK_COST_REGIONAL"|"$STACK_BASE"|"$STACK_SERVICES") echo "$APP_REGION" ;;
    *) return 1 ;;
  esac
}

finish_inventory() { # print the plan; stop on any problem
  step "plan"
  if [ -s "$PLAN" ]; then cat "$PLAN" >&2; else log "  nothing to delete"; fi
  if [ -s "$PROBLEMS" ]; then
    log ""
    log "REFUSING: these would be deleted but fail the interlock; nothing was deleted:"
    cat "$PROBLEMS" >&2
    exit 1
  fi
}

delete_stack() { # <region> <stack>
  local region="$1" stack="$2" status seen
  stack_refresh "$region" "$stack"
  status=$(stack_status "$region" "$stack")
  [ "$status" != NONE ] || { log "  $stack: already gone"; return 0; }
  require_staging_stack "$region" "$stack"
  step "deleting $stack ($region)"
  seen="$STAGING_TMP/events.$region.$stack"
  seed_stack_events "$region" "$stack" "$seen"
  awsx "$region" cloudformation delete-stack --stack-name "$stack"
  wait_stack "$region" "$stack" delete "$seen" || die "$stack did not delete; the events above say why"
  log "  deleted"
}

# Running task ARNs in <cluster> (none when the cluster does not exist).
running_task_arns() {
  local arns
  if arns=$(awsx_capture "$APP_REGION" ecs list-tasks --cluster "$1" --desired-status RUNNING \
      --query 'taskArns' --output text); then
    [ "$arns" = None ] || printf '%s\n' "$arns"
  elif aws_last_error_matches ClusterNotFoundException; then
    return 0
  else
    aws_last_error_print
    return 1
  fi
}

stray_tasks_json() { # <cluster>: one JSON object per running task no service owns
  local arns
  arns=$(running_task_arns "$1") || return 1
  [ -n "$arns" ] || return 0
  # shellcheck disable=SC2086 # task ARNs split on whitespace
  awsx "$APP_REGION" ecs describe-tasks --cluster "$1" --tasks $arns --include TAGS --output json |
    jq -c '.tasks[] | select((.group // "") | startswith("service:") | not)'
}

# ------------------------------------------------------------------ inventory
account=""
buckets=""
zone=""

inventory_environment() {
  local region stack status cluster tasks rows row arn tag name state count
  account=$(account_id)
  step "inventory (account $account)"

  for stack in "$STACK_SERVICES" "$STACK_BASE" "$STACK_SES"; do
    region=$(stack_region "$stack")
    status=$(stack_status "$region" "$stack")
    [ "$status" != NONE ] || continue
    stack_check "$region" "$stack"
    planned stack "$stack ($region, $status)"
  done

  # Tasks the services do not own (run-task, e.g. a migrator) keep the
  # cluster from being deleted.
  status=$(stack_status "$APP_REGION" "$STACK_BASE")
  if [ "$status" != NONE ]; then
    cluster=$(stack_output "$APP_REGION" "$STACK_BASE" ClusterName)
    cluster=${cluster:-$CLUSTER}
    tasks=$(stray_tasks_json "$cluster") || die "could not list the tasks in $cluster"
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      arn=$(printf '%s' "$row" | jq -r '.taskArn')
      tag=$(printf '%s' "$row" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.tags // [])[] | select(.key == $k) | .value][0] // ""')
      tag_check "task ${arn##*/}" "$tag"
      planned task "stop ${arn##*/} ($(printf '%s' "$row" | jq -r '.group'))"
    done <<EOF
$tasks
EOF
    for name in UploadsBucketName AssetsBucketName ExportsBucketName; do
      buckets="$buckets $(stack_output "$APP_REGION" "$STACK_BASE" "$name")"
    done
  else
    buckets="postwave-staging-uploads-$account postwave-staging-assets-$account postwave-staging-exports-$account"
  fi
  for name in $buckets; do
    if ! awsx_capture "$APP_REGION" s3api head-bucket --bucket "$name" >/dev/null; then
      aws_last_error_matches '404|Not Found|NoSuchBucket' && continue
      aws_last_error_print; die "could not read bucket $name"
    fi
    if tag=$(awsx_capture "$APP_REGION" s3api get-bucket-tagging --bucket "$name" \
        --query "TagSet[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text); then :
    elif aws_last_error_matches NoSuchTagSet; then tag=""
    else aws_last_error_print; die "could not read the tags of bucket $name"
    fi
    tag_check "bucket $name" "$tag"
    planned bucket "empty $name (every version), then CloudFormation deletes it"
  done

  zone=$(hosted_zone_id)
  count=$(acm_records | jq 'length')
  [ "$count" = 0 ] || planned dns "$count ACM validation CNAME(s) under $DOMAIN, if CloudFormation leaves them and no certificate needs them"

  rows=$(snapshots_tsv) || die "could not list the database snapshots"
  count=0
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    tag_check "snapshot ${row%%	*}" "${row#*	}"
    count=$((count + 1))
  done <<EOF
$rows
EOF
  [ "$count" = 0 ] || planned snapshots "$count DLM snapshot(s) of the database volume"

  for name in $ECR_REPOS; do
    if arn=$(awsx_capture "$APP_REGION" ecr describe-repositories --repository-names "$name" \
        --query 'repositories[0].repositoryArn' --output text); then
      tag=$(awsx "$APP_REGION" ecr list-tags-for-resource --resource-arn "$arn" \
        --query "tags[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text)
      tag_check "ECR repository $name" "$tag"
      planned ecr "$name and all its images"
    elif ! aws_last_error_matches RepositoryNotFoundException; then
      aws_last_error_print; die "could not read ECR repository $name"
    fi
  done

  rows=$(secrets_tsv) || die "could not list the secrets"
  while IFS='	' read -r name state tag; do
    [ -n "$name" ] || continue
    if [ "$state" = pending ] && [ "${FORCE_DELETE_SECRETS:-0}" != 1 ]; then continue; fi
    tag_check "secret $name" "$tag"
    planned secret "$name ($state)"
  done <<EOF
$rows
EOF

  inventory_build_side
}

# name<TAB>state<TAB>tag for every secret under the prefix (not only known ones)
secrets_tsv() {
  secrets_json | jq -r --arg k "$PROJECT_TAG_KEY" '
    (.SecretList // [])[] |
    [.Name, (if (.DeletedDate // null) != null then "pending" else "active" end),
     ([(.Tags // [])[] | select(.Key == $k) | .Value][0] // "")] | @tsv'
}

snapshots_tsv() { # id<TAB>Project tag, for snapshots of the staging database volume
  awsx "$APP_REGION" ec2 describe-snapshots --owner-ids self \
    --filters Name=tag:Backup,Values=postwave-staging-db --output json |
    jq -r --arg k "$PROJECT_TAG_KEY" '.Snapshots[] |
      [.SnapshotId, ([(.Tags // [])[] | select(.Key == $k) | .Value][0] // "")] | @tsv'
}

acm_records() { # JSON array of ACM validation CNAMEs under the staging domain
  awsx "$GLOBAL_REGION" route53 list-resource-record-sets --hosted-zone-id "$zone" --output json |
    jq --arg p "$ACM_RECORD_PATTERN" '[.ResourceRecordSets[] |
      select(.Type == "CNAME" and (.Name | test($p)) and
             ((.ResourceRecords // []) | length > 0) and
             all(.ResourceRecords[]; .Value | endswith(".acm-validations.aws.")))]'
}

build_objects_tsv() { # key<TAB>Project tag, for this project's objects in the source bucket
  local bucket="$1" keys key tag
  if ! keys=$(awsx_capture "$BUILD_REGION" s3api list-objects-v2 --bucket "$bucket" \
      --prefix "$SOURCE_PREFIX/" --query 'Contents[].Key' --output text); then
    aws_last_error_matches NoSuchBucket && return 0
    aws_last_error_print
    return 1
  fi
  for key in $(printf '%s\n' "$keys" | tr '\t' '\n' | awk 'NF && $0 != "None"'); do
    tag=$(awsx "$BUILD_REGION" s3api get-object-tagging --bucket "$bucket" --key "$key" \
      --query "TagSet[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text) || return 1
    printf '%s\t%s\n' "$key" "$tag"
  done
}

inventory_build_side() {
  local count tag bucket row rows arn
  count=$(awsx "$BUILD_REGION" codebuild batch-get-projects --names "$CODEBUILD_PROJECT" \
    --query 'length(projects)' --output text)
  if [ "$count" = 1 ]; then
    tag=$(awsx "$BUILD_REGION" codebuild batch-get-projects --names "$CODEBUILD_PROJECT" \
      --query "projects[0].tags[?key=='$PROJECT_TAG_KEY'].value | [0]" --output text)
    tag_check "CodeBuild project $CODEBUILD_PROJECT" "$tag"
    planned codebuild "project $CODEBUILD_PROJECT ($BUILD_REGION)"
  fi
  arn=$(awsx "$BUILD_REGION" logs describe-log-groups --log-group-name-prefix "$CODEBUILD_LOG_GROUP" \
    --query "logGroups[?logGroupName=='$CODEBUILD_LOG_GROUP'].logGroupArn | [0]" --output text)
  if [ -n "$arn" ] && [ "$arn" != None ]; then
    tag=$(awsx "$BUILD_REGION" logs list-tags-for-resource --resource-arn "$arn" \
      --query "tags.$PROJECT_TAG_KEY" --output text)
    tag_check "log group $CODEBUILD_LOG_GROUP" "$tag"
    planned log-group "$CODEBUILD_LOG_GROUP ($BUILD_REGION)"
  fi
  bucket=${STAGING_SOURCE_BUCKET:-docai-codebuild-source-$account}
  rows=$(build_objects_tsv "$bucket") || die "could not list s3://$bucket/$SOURCE_PREFIX/"
  count=0
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    tag_check "object s3://$bucket/${row%%	*}" "${row#*	}"
    count=$((count + 1))
  done <<EOF
$rows
EOF
  [ "$count" = 0 ] || planned s3-objects "$count object(s) under s3://$bucket/$SOURCE_PREFIX/"
}

# ------------------------------------------------------------------ deleting
empty_bucket() { # <bucket>
  local bucket="$1" tag page="$STAGING_TMP/versions.json" batch="$STAGING_TMP/delete.json" n total=0
  tag=$(awsx "$APP_REGION" s3api get-bucket-tagging --bucket "$bucket" \
    --query "TagSet[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text 2>/dev/null || true)
  require_tagged "bucket $bucket" "$tag"
  while :; do
    awsx "$APP_REGION" s3api list-object-versions --bucket "$bucket" --max-items 1000 --output json >"$page"
    # delete-objects takes at most 1000 keys; versions + markers can be more.
    jq '{Objects: ([((.Versions // []) + (.DeleteMarkers // []))[] | {Key, VersionId}] | .[0:1000]), Quiet: true}' "$page" >"$batch"
    n=$(jq '.Objects | length' "$batch")
    [ "$n" != 0 ] || break
    awsx "$APP_REGION" s3api delete-objects --bucket "$bucket" --delete "file://$batch" --output json >"$page"
    [ "$(jq '(.Errors // []) | length' "$page")" = 0 ] || { jq -c '.Errors[0:5]' "$page" >&2; die "could not delete objects in $bucket"; }
    total=$((total + n))
  done
  log "  $bucket: $total object version(s) deleted"
}

teardown_all() {
  local status bucket row rows arn key tag records certs region name state count
  inventory_environment
  finish_inventory
  if is_dry_run; then plan "delete everything listed above, in the order in the header"; return 0; fi
  [ -s "$PLAN" ] || return 0
  confirm_phrase "$CONFIRM_PHRASE"

  status=$(stack_status "$APP_REGION" "$STACK_BASE")
  if [ "$status" != NONE ]; then
    cluster=$(stack_output "$APP_REGION" "$STACK_BASE" ClusterName)
    cluster=${cluster:-$CLUSTER}
    rows=$(stray_tasks_json "$cluster") || die "could not list the tasks in $cluster"
    while IFS= read -r row; do
      [ -n "$row" ] || continue
      arn=$(printf '%s' "$row" | jq -r '.taskArn')
      tag=$(printf '%s' "$row" | jq -r --arg k "$PROJECT_TAG_KEY" '[(.tags // [])[] | select(.key == $k) | .value][0] // ""')
      require_tagged "task ${arn##*/}" "$tag"
      awsx "$APP_REGION" ecs stop-task --cluster "$cluster" --task "$arn" --reason "moosewave-staging teardown" >/dev/null
      awsx "$APP_REGION" ecs wait tasks-stopped --cluster "$cluster" --tasks "$arn"
      log "  stopped task ${arn##*/}"
    done <<EOF
$rows
EOF
  fi

  delete_stack "$APP_REGION" "$STACK_SERVICES"

  step "emptying the staging buckets"
  for bucket in $buckets; do
    if awsx_capture "$APP_REGION" s3api head-bucket --bucket "$bucket" >/dev/null; then empty_bucket "$bucket"; fi
  done

  delete_stack "$APP_REGION" "$STACK_BASE"

  step "leftover ACM validation records"
  certs=0
  for region in "$APP_REGION" "$GLOBAL_REGION" "$SES_REGION"; do
    count=$(awsx "$region" acm list-certificates --output json |
      jq --arg d "$DOMAIN" '[.CertificateSummaryList[] | select(.DomainName == $d or .DomainName == "*.\($d)")] | length')
    certs=$((certs + count))
  done
  records=$(acm_records)
  if [ "$(printf '%s' "$records" | jq 'length')" = 0 ]; then
    log "  none left"
  elif [ "$certs" != 0 ]; then
    log "  kept: $certs ACM certificate(s) for $DOMAIN still exist and may need them"
  else
    printf '%s' "$records" | jq -c '.[]' | while IFS= read -r row; do
      name=$(printf '%s' "$row" | jq -r '.Name')
      printf '%s' "$row" | jq '{Comment: "moosewave-staging teardown: leftover ACM validation record",
        Changes: [{Action: "DELETE", ResourceRecordSet: .}]}' >"$STAGING_TMP/change.json"
      awsx "$GLOBAL_REGION" route53 change-resource-record-sets --hosted-zone-id "$zone" \
        --change-batch "file://$STAGING_TMP/change.json" --query ChangeInfo.Status --output text >/dev/null || exit 1
      log "  deleted $name"
    done
  fi

  step "database snapshots"
  rows=$(snapshots_tsv) || die "could not list the database snapshots"
  count=0
  while IFS='	' read -r name tag; do
    [ -n "$name" ] || continue
    require_tagged "snapshot $name" "$tag"
    awsx "$APP_REGION" ec2 delete-snapshot --snapshot-id "$name"
    count=$((count + 1))
  done <<EOF
$rows
EOF
  log "  $count deleted"

  delete_stack "$SES_REGION" "$STACK_SES"

  step "ECR repositories"
  for name in $ECR_REPOS; do
    if arn=$(awsx_capture "$APP_REGION" ecr describe-repositories --repository-names "$name" \
        --query 'repositories[0].repositoryArn' --output text); then
      tag=$(awsx "$APP_REGION" ecr list-tags-for-resource --resource-arn "$arn" \
        --query "tags[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text)
      require_tagged "ECR repository $name" "$tag"
      awsx "$APP_REGION" ecr delete-repository --repository-name "$name" --force >/dev/null
      log "  deleted $name"
    fi
  done

  step "secrets"
  secrets_refresh
  rows=$(secrets_tsv) || die "could not list the secrets"
  while IFS='	' read -r name state tag; do
    [ -n "$name" ] || continue
    if [ "${FORCE_DELETE_SECRETS:-0}" = 1 ]; then
      require_tagged "secret $name" "$tag"
      awsx "$APP_REGION" secretsmanager delete-secret --secret-id "$name" --force-delete-without-recovery >/dev/null
      log "  deleted $name"
    elif [ "$state" = active ]; then
      require_tagged "secret $name" "$tag"
      awsx "$APP_REGION" secretsmanager delete-secret --secret-id "$name" --recovery-window-in-days 7 >/dev/null
      log "  scheduled $name (7-day recovery window)"
    fi
  done <<EOF
$rows
EOF

  step "image build ($BUILD_REGION)"
  count=$(awsx "$BUILD_REGION" codebuild batch-get-projects --names "$CODEBUILD_PROJECT" \
    --query 'length(projects)' --output text)
  if [ "$count" = 1 ]; then
    tag=$(awsx "$BUILD_REGION" codebuild batch-get-projects --names "$CODEBUILD_PROJECT" \
      --query "projects[0].tags[?key=='$PROJECT_TAG_KEY'].value | [0]" --output text)
    require_tagged "CodeBuild project $CODEBUILD_PROJECT" "$tag"
    awsx "$BUILD_REGION" codebuild delete-project --name "$CODEBUILD_PROJECT" >/dev/null
    log "  deleted project $CODEBUILD_PROJECT"
  fi
  arn=$(awsx "$BUILD_REGION" logs describe-log-groups --log-group-name-prefix "$CODEBUILD_LOG_GROUP" \
    --query "logGroups[?logGroupName=='$CODEBUILD_LOG_GROUP'].logGroupArn | [0]" --output text)
  if [ -n "$arn" ] && [ "$arn" != None ]; then
    tag=$(awsx "$BUILD_REGION" logs list-tags-for-resource --resource-arn "$arn" --query "tags.$PROJECT_TAG_KEY" --output text)
    require_tagged "log group $CODEBUILD_LOG_GROUP" "$tag"
    awsx "$BUILD_REGION" logs delete-log-group --log-group-name "$CODEBUILD_LOG_GROUP"
    log "  deleted log group $CODEBUILD_LOG_GROUP"
  fi
  bucket=${STAGING_SOURCE_BUCKET:-docai-codebuild-source-$account}
  rows=$(build_objects_tsv "$bucket") || die "could not list s3://$bucket/$SOURCE_PREFIX/"
  count=0
  while IFS='	' read -r key tag; do
    [ -n "$key" ] || continue
    require_tagged "object s3://$bucket/$key" "$tag"
    awsx "$BUILD_REGION" s3api delete-object --bucket "$bucket" --key "$key" >/dev/null
    count=$((count + 1))
  done <<EOF
$rows
EOF
  log "  $count object(s) deleted from s3://$bucket/$SOURCE_PREFIX/"

  step "still tagged $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE"
  for region in "$APP_REGION" "$SES_REGION" "$GLOBAL_REGION"; do
    awsx "$region" resourcegroupstaggingapi get-resources \
      --tag-filters "Key=$PROJECT_TAG_KEY,Values=$PROJECT_TAG_VALUE" \
      --query 'ResourceTagMappingList[].ResourceARN' --output text | tr '\t' '\n' | awk 'NF' | sed 's/^/  /' >&2
  done
  log "expected: the cost-guard stacks' resources and KMS keys pending deletion (the tag index lags by minutes)."
  log "keep the cost guard until the daily digest shows \$0.00 twice, then: teardown.sh cost-guard"
}

teardown_cost_guard() {
  local stack region status
  step "inventory"
  for stack in "$STACK_SERVICES" "$STACK_BASE" "$STACK_SES"; do
    region=$(stack_region "$stack")
    status=$(stack_status "$region" "$stack")
    [ "$status" = NONE ] || die "refusing: $stack still exists ($status); the cost guard outlives the environment (teardown.sh first)"
  done
  for stack in "$STACK_COST_REGIONAL" "$STACK_COST_GLOBAL"; do
    region=$(stack_region "$stack")
    status=$(stack_status "$region" "$stack")
    [ "$status" != NONE ] || continue
    stack_check "$region" "$stack"
    planned stack "$stack ($region, $status)"
  done
  finish_inventory
  if is_dry_run; then plan "delete the cost-guard stacks listed above"; return 0; fi
  [ -s "$PLAN" ] || return 0
  confirm_phrase "$CONFIRM_PHRASE"
  delete_stack "$APP_REGION" "$STACK_COST_REGIONAL"
  delete_stack "$GLOBAL_REGION" "$STACK_COST_GLOBAL"
}

teardown_one_stack() { # <stack>
  local stack="$1" region status
  region=$(stack_region "$stack") || die "not a staging stack: $stack (one of $STACK_COST_GLOBAL $STACK_COST_REGIONAL $STACK_SES $STACK_BASE $STACK_SERVICES)"
  status=$(stack_status "$region" "$stack")
  [ "$status" != NONE ] || { log "$stack does not exist"; return 0; }
  if [ "$stack" = "$STACK_BASE" ]; then
    [ "$(stack_status "$APP_REGION" "$STACK_SERVICES")" = NONE ] ||
      die "refusing: $STACK_SERVICES imports from $STACK_BASE; delete it first (or use teardown.sh all)"
  fi
  stack_check "$region" "$stack"
  planned stack "$stack ($region, $status)"
  if [ "$stack" = "$STACK_BASE" ]; then
    account=$(account_id)
    for name in UploadsBucketName AssetsBucketName ExportsBucketName; do
      name=$(stack_output "$APP_REGION" "$STACK_BASE" "$name")
      [ -z "$name" ] || { buckets="$buckets $name"; planned bucket "empty $name first"; }
    done
  fi
  finish_inventory
  if is_dry_run; then plan "delete $stack"; return 0; fi
  confirm_phrase "$stack"
  for name in $buckets; do
    if awsx_capture "$APP_REGION" s3api head-bucket --bucket "$name" >/dev/null; then empty_bucket "$name"; fi
  done
  delete_stack "$region" "$stack"
}

case "${1:-all}" in
  all) teardown_all ;;
  cost-guard) teardown_cost_guard ;;
  stack) [ -n "${2:-}" ] || die "usage: teardown.sh stack <name>"; teardown_one_stack "$2" ;;
  -h|--help|help) usage_from_header "$0" ;;
  *) usage_from_header "$0" >&2; exit 2 ;;
esac
