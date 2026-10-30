#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# deploy-web-only.sh -- NON-PRODUCTION. Roll the recorded staging web image
# without changing the deployed services template or touching the API. This is
# useful while a newer API template requires provider secrets not yet supplied.
#
#   infra/aws/staging/scripts/deploy-web-only.sh
#   DRY_RUN=1 infra/aws/staging/scripts/deploy-web-only.sh
#
# Requires build-images.sh to have recorded web and web.release in digests.env.
# Uses a reviewed CloudFormation change set with the deployed template; it
# refuses any resource change outside WebTaskDefinition and WebService.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

case "${1:-}" in -h|--help) usage_from_header "$0"; exit 0 ;; esac
[ "$#" -eq 0 ] || die "usage: deploy-web-only.sh (reads web digest and release from staging state)"
require_cmd jq

digest=$(state_digest web)
release=$(state_digest web.release)
printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' ||
  die "no valid web digest in $STAGING_STATE_DIR/$DIGESTS_FILE_NAME"
printf '%s' "$release" | grep -Eq '^[0-9a-f]{40}$' ||
  die "no valid web.release in $STAGING_STATE_DIR/$DIGESTS_FILE_NAME"

status=$(stack_status "$APP_REGION" "$STACK_SERVICES")
status_is_complete "$status" || die "$STACK_SERVICES is $status; wait for a stable stack"
require_staging_stack "$APP_REGION" "$STACK_SERVICES"
[ "$(stack_param "$APP_REGION" "$STACK_SERVICES" DeployWeb)" = true ] ||
  die "the web service is disabled; use the normal staging deployment procedure"
current_digest=$(stack_param "$APP_REGION" "$STACK_SERVICES" WebImageDigest)
current_release=$(stack_param "$APP_REGION" "$STACK_SERVICES" ReleaseId)
if [ "$current_digest" = "$digest" ] && [ "$current_release" = "$release" ]; then
  log "web is already at ${release:0:12} ($digest)"
  exit 0
fi

repo_arn=$(awsx "$APP_REGION" ecr describe-repositories --repository-names postwave-web \
  --query 'repositories[0].repositoryArn' --output text)
repo_tag=$(awsx "$APP_REGION" ecr list-tags-for-resource --resource-arn "$repo_arn" \
  --query "tags[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text)
require_tagged "ECR repository postwave-web" "$repo_tag"
image=$(awsx "$APP_REGION" ecr describe-images --repository-name postwave-web \
  --image-ids "imageDigest=$digest" --output json)
printf '%s' "$image" | jq -e --arg release "$release" \
  '(.imageDetails | length) == 1 and (.imageDetails[0].imageTags // [] | index($release) != null)' >/dev/null ||
  die "the web digest is not tagged with the recorded release $release"

parameters=$(stack_json "$APP_REGION" "$STACK_SERVICES" | jq -c \
  --arg digest "$digest" --arg release "$release" '
  [.Stacks[0].Parameters[] |
    if .ParameterKey == "WebImageDigest" then
      {ParameterKey: .ParameterKey, ParameterValue: $digest}
    elif .ParameterKey == "ReleaseId" then
      {ParameterKey: .ParameterKey, ParameterValue: $release}
    else {ParameterKey: .ParameterKey, UsePreviousValue: true} end]')
printf '%s' "$parameters" | jq -e '
  any(.[]; .ParameterKey == "WebImageDigest") and
  any(.[]; .ParameterKey == "ReleaseId")' >/dev/null || die "the live stack lacks web release parameters"

step "web-only rollout ${current_release:0:12} -> ${release:0:12}"
if is_dry_run; then
  plan "create a change set using the deployed $STACK_SERVICES template with only WebImageDigest and ReleaseId changed"
  plan "execute it only if WebTaskDefinition/WebService are the sole changed resources, then wait for web health"
  exit 0
fi

change_set_name="moosewave-web-$(date -u +%Y%m%d%H%M%S)-$$"
change_set=$(awsx "$APP_REGION" cloudformation create-change-set \
  --stack-name "$STACK_SERVICES" --change-set-name "$change_set_name" \
  --change-set-type UPDATE --use-previous-template --parameters "$parameters" \
  --capabilities CAPABILITY_IAM \
  --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" \
  --description "web-only staging release ${release:0:12}" \
  --query Id --output text)

deadline=$(( $(now) + 900 ))
while :; do
  change_status=$(awsx "$APP_REGION" cloudformation describe-change-set \
    --change-set-name "$change_set" --query Status --output text)
  case "$change_status" in CREATE_COMPLETE|FAILED) break ;; esac
  [ "$(now)" -lt "$deadline" ] || die "change set did not finish in 15 minutes: $change_set"
  sleep 5
done
change_json=$(awsx "$APP_REGION" cloudformation describe-change-set \
  --change-set-name "$change_set" --output json)
if [ "$change_status" != CREATE_COMPLETE ]; then
  reason=$(printf '%s' "$change_json" | jq -r '.StatusReason // ""')
  awsx "$APP_REGION" cloudformation delete-change-set --change-set-name "$change_set"
  die "web-only change set failed: $reason"
fi
if ! printf '%s' "$change_json" | jq -e '.NextToken == null' >/dev/null; then
  awsx "$APP_REGION" cloudformation delete-change-set --change-set-name "$change_set"
  die "refusing a paginated web-only change set; review the deployment inputs"
fi
if ! printf '%s' "$change_json" | jq -e '
  ([.Changes[].ResourceChange.LogicalResourceId] | index("WebTaskDefinition") != null) and
  all(.Changes[].ResourceChange;
    (.LogicalResourceId == "WebTaskDefinition" or .LogicalResourceId == "WebService") and
    (.LogicalResourceId != "WebService" or (.Replacement != "True" and .Replacement != "Conditional")))' >/dev/null; then
  awsx "$APP_REGION" cloudformation delete-change-set --change-set-name "$change_set"
  die "refusing a non-web or replacement-service change"
fi
printf '%s' "$change_json" | jq -r '.Changes[].ResourceChange |
  "  \(.Action) \(.LogicalResourceId) replacement=\(.Replacement // "n/a")"' >&2

seen="$STAGING_TMP/events.web"
seed_stack_events "$APP_REGION" "$STACK_SERVICES" "$seen"
awsx "$APP_REGION" cloudformation execute-change-set --change-set-name "$change_set"
wait_stack "$APP_REGION" "$STACK_SERVICES" update "$seen" ||
  die "web-only stack update did not complete"
awsx "$APP_REGION" ecs wait services-stable --cluster "$CLUSTER" --services postwave-web
bash "$STAGING_SCRIPTS_DIR/smoke.sh" web
log "web-only staging rollout complete: $release ($digest); API image unchanged"
