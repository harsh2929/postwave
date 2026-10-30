#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# build-images.sh -- NON-PRODUCTION. Builds the Moosewave staging images on
# AWS CodeBuild from one commit, pushes them to the us-west-2 ECR
# repositories, and records their digests for deploy.sh.
#
#   build-images.sh [<commit>]        (default HEAD)
#
# 1. Exports exactly the commit's tracked files with scripts/ci/aws-ci.sh
#    --export-only (verified byte for byte against the tree; uncommitted work
#    in this clone is never shipped).
# 2. Makes sure the five ECR repositories exist in us-west-2, tagged
#    Project=moosewave-staging, with a keep-last-5 lifecycle. A same-named
#    repository WITHOUT that tag is refused: the names are production's too.
# 3. Uploads the zip over S3's dual-stack endpoint to the account's CodeBuild
#    source bucket (us-east-1), checks the stored size, and tags the object.
# 4. Creates or refreshes CodeBuild project moosewave-staging-images
#    (us-east-1, ARM_CONTAINER, amazonlinux-aarch64-standard:3.0,
#    BUILD_GENERAL1_LARGE, privileged, role codebuild-docai-role, tagged
#    Project=moosewave-staging, logs in a 14-day tagged log group) running
#    infra/aws/staging/buildspec-images.yml.
# 5. Starts the build, waits, prints each pushed digest, and merges them into
#    $STAGING_STATE_DIR/digests.env (default ~/.local/state/moosewave-staging),
#    which deploy.sh reads. On failure it prints the end of the build log.
#
# Environment:
#   IMAGES                  comma-separated subset of api,api-mjml,db-migrator,
#                           clamav,listmonk,web (default api-mjml,db-migrator,clamav,listmonk)
#   CONSENT_SITE_KEY        the staging pwk_ consent site key; required with web
#   ASSETS_PUBLIC_BASE_URL  web build (default: the services stack's
#                           AssetsPublicBaseUrl, else https://assets.staging.moosewave.com)
#   DOCKERHUB_SECRET_ID     us-east-1 secret {username,password} used for Docker Hub
#                           pulls (default dockerhub-credentials; set empty for anonymous)
#   STAGING_SOURCE_BUCKET   source bucket (default docai-codebuild-source-<account>)
#   NO_WAIT=1               start the build and exit (digests are then not recorded)
#   DRY_RUN=1               check inputs and print the plan; export, create,
#                           upload and start nothing

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd git jq zip unzip

readonly VALID_IMAGES="api api-mjml db-migrator clamav listmonk web"
readonly BUILDSPEC=infra/aws/staging/buildspec-images.yml
readonly CODEBUILD_IMAGE=aws/codebuild/amazonlinux-aarch64-standard:3.0
IMAGES=${IMAGES:-api-mjml,db-migrator,clamav,listmonk}
DOCKERHUB_SECRET_ID=${DOCKERHUB_SECRET_ID-dockerhub-credentials}

selected_images() { printf '%s\n' "$IMAGES" | tr -s ', ' '\n' | awk 'NF'; }
image_selected() { selected_images | grep -Fxq "$1"; }

ref="${1:-HEAD}"
case "$ref" in -h|--help) usage_from_header "$0"; exit 0 ;; esac
cd "$REPO_ROOT"
sha=$(git rev-parse --verify "${ref}^{commit}")
subject=$(git log -1 --format=%s "$sha")
step "staging images for ${sha:0:12} ($subject)"

for image in $(selected_images); do
  case " $VALID_IMAGES " in *" $image "*) ;; *) die "unknown image '$image' (valid: $VALID_IMAGES)" ;; esac
done
log "images: $(selected_images | tr '\n' ' ')"

# Without configuredPlatformSender, the segment-decay, dashboard-digest and
# webhook-alert workers send from @moosewave.com, which the staging SES policy
# refuses. Everything else works, so this only warns.
if image_selected api || image_selected api-mjml; then
  git grep -q 'func configuredPlatformSender' "$sha" -- apps/api ||
    warn "apps/api at ${sha:0:12} passes no platform sender to the segment-decay, dashboard-digest and webhook-alert workers; SES refuses those three staging mails (they fall back to @moosewave.com) until a commit with configuredPlatformSender() is built"
fi

account=$(account_id)
registry="$account.dkr.ecr.$APP_REGION.amazonaws.com"
bucket=${STAGING_SOURCE_BUCKET:-docai-codebuild-source-$account}
role_arn="arn:aws:iam::$account:role/$CODEBUILD_ROLE_NAME"
source_key="$SOURCE_PREFIX/source/$sha.zip"
upload_origin=""
assets_url=""
web_selected=0
if image_selected web; then web_selected=1; fi

# ---------------------------------------------------------------- web inputs
if [ "$web_selected" = 1 ]; then
  git show "$sha:apps/web/Dockerfile" | grep -q '^ARG POSTWAVE_WEB_CANONICAL_DOMAIN' ||
    die "apps/web/Dockerfile at ${sha:0:12} has no POSTWAVE_WEB_CANONICAL_DOMAIN build arg, so it can only build for moosewave.com; build a commit that includes it"
  printf '%s' "${CONSENT_SITE_KEY:-}" | grep -Eq '^pwk_[0-9a-f]{48}$' ||
    die "web needs CONSENT_SITE_KEY=pwk_<48 hex>, minted against the staging API (see README)"
  upload_origin=$(stack_output "$APP_REGION" "$STACK_BASE" UploadsBucketRegionalOrigin)
  [ -n "$upload_origin" ] || die "web needs $STACK_BASE's UploadsBucketRegionalOrigin output; deploy base first"
  assets_url=${ASSETS_PUBLIC_BASE_URL:-$(stack_param "$APP_REGION" "$STACK_SERVICES" AssetsPublicBaseUrl)}
  assets_url=${assets_url:-https://assets.$DOMAIN}
  log "web: upload origin $upload_origin, assets $assets_url"
fi

# ------------------------------------------------------------ prerequisites
awsx "$GLOBAL_REGION" iam get-role --role-name "$CODEBUILD_ROLE_NAME" --query Role.Arn --output text >/dev/null ||
  die "IAM role $CODEBUILD_ROLE_NAME does not exist"

ensure_repository() { # <name>
  local repo="$1" arn tag
  if arn=$(awsx_capture "$APP_REGION" ecr describe-repositories --repository-names "$repo" \
      --query 'repositories[0].repositoryArn' --output text); then
    tag=$(awsx "$APP_REGION" ecr list-tags-for-resource --resource-arn "$arn" \
      --query "tags[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text) || return 1
    require_tagged "ECR repository $repo" "$tag"
    log "  exists     $repo"
  elif aws_last_error_matches RepositoryNotFoundException; then
    if is_dry_run; then plan "create ECR repository $repo (tagged, scan on push, keep last 5)"; return 0; fi
    awsx "$APP_REGION" ecr create-repository --repository-name "$repo" \
      --image-tag-mutability MUTABLE --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 \
      --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" >/dev/null || return 1
    log "  created    $repo"
  else
    aws_last_error_print
    return 1
  fi
  if ! is_dry_run; then
    awsx "$APP_REGION" ecr put-lifecycle-policy --repository-name "$repo" \
      --lifecycle-policy-text "file://$STAGING_TMP/lifecycle.json" >/dev/null || return 1
  fi
}

step "ECR repositories ($APP_REGION)"
cat >"$STAGING_TMP/lifecycle.json" <<'JSON'
{"rules":[{"rulePriority":1,"description":"keep the last 5 staging images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}
JSON
for repo in $ECR_REPOS; do ensure_repository "$repo"; done

step "CodeBuild log group $CODEBUILD_LOG_GROUP ($BUILD_REGION)"
# Created here, not by CodeBuild, so it is tagged and expires after 14 days.
log_group_arn=$(awsx "$BUILD_REGION" logs describe-log-groups --log-group-name-prefix "$CODEBUILD_LOG_GROUP" \
  --query "logGroups[?logGroupName=='$CODEBUILD_LOG_GROUP'].logGroupArn | [0]" --output text)
if [ "$log_group_arn" = None ] || [ -z "$log_group_arn" ]; then
  if is_dry_run; then plan "create log group $CODEBUILD_LOG_GROUP (14-day retention, tagged)"
  else
    awsx "$BUILD_REGION" logs create-log-group --log-group-name "$CODEBUILD_LOG_GROUP" \
      --tags "$PROJECT_TAG_KEY=$PROJECT_TAG_VALUE"
    log "  created"
  fi
else
  log_group_tag=$(awsx "$BUILD_REGION" logs list-tags-for-resource --resource-arn "$log_group_arn" \
    --query "tags.$PROJECT_TAG_KEY" --output text)
  if [ "$log_group_tag" != "$PROJECT_TAG_VALUE" ]; then
    if is_dry_run; then plan "tag log group $CODEBUILD_LOG_GROUP $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE"
    else
      awsx "$BUILD_REGION" logs tag-resource --resource-arn "$log_group_arn" \
        --tags "$PROJECT_TAG_KEY=$PROJECT_TAG_VALUE"
      log "  tagged"
    fi
  fi
  log "  exists"
fi
if ! is_dry_run; then
  awsx "$BUILD_REGION" logs put-retention-policy --log-group-name "$CODEBUILD_LOG_GROUP" --retention-in-days 14
fi

# ---------------------------------------------------------- export + upload
if is_dry_run; then
  plan "export ${sha:0:12} with scripts/ci/aws-ci.sh --export-only and upload it to s3://$bucket/$source_key (dual-stack)"
else
  step "exporting ${sha:0:12}"
  "$REPO_ROOT/scripts/ci/aws-ci.sh" "$sha" --export-only "$STAGING_TMP/export" >&2
  zip_path="$STAGING_TMP/export/$sha.zip"
  [ -s "$zip_path" ] || die "the export produced no zip"
  size=$(wc -c <"$zip_path" | tr -d ' ')
  step "uploading $size bytes to s3://$bucket/$source_key"
  # Few concurrent parts: a slow uplink starves the CLI default of 40.
  printf '[default]\ns3 =\n  max_concurrent_requests = 3\n  multipart_chunksize = 16MB\n  multipart_threshold = 64MB\n' >"$STAGING_TMP/s3.cfg"
  [ -z "${AWS_PROFILE:-}" ] || printf '[profile %s]\ns3 =\n  max_concurrent_requests = 3\n  multipart_chunksize = 16MB\n  multipart_threshold = 64MB\n' "$AWS_PROFILE" >>"$STAGING_TMP/s3.cfg"
  uploaded=0
  for attempt in 1 2 3; do
    AWS_CONFIG_FILE="$STAGING_TMP/s3.cfg" awsx "$BUILD_REGION" s3 cp --only-show-errors "$zip_path" "s3://$bucket/$source_key" || true
    # A multipart upload has reported success while leaving no object behind,
    # so the stored size is the proof.
    stored=$(awsx "$BUILD_REGION" s3api head-object --bucket "$bucket" --key "$source_key" \
      --query ContentLength --output text 2>/dev/null || echo 0)
    if [ "$stored" = "$size" ]; then uploaded=1; break; fi
    log "  attempt $attempt left size=$stored; retrying"
  done
  [ "$uploaded" = 1 ] || die "upload failed three times"
  awsx "$BUILD_REGION" s3api put-object-tagging --bucket "$bucket" --key "$source_key" \
    --tagging "TagSet=[{Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE}]"
  log "  uploaded and tagged"
fi

# ---------------------------------------------------------- CodeBuild project
step "CodeBuild project $CODEBUILD_PROJECT ($BUILD_REGION)"
jq -n --arg name "$CODEBUILD_PROJECT" --arg bucket "$bucket" --arg prefix "$SOURCE_PREFIX" \
  --arg buildspec "$BUILDSPEC" --arg image "$CODEBUILD_IMAGE" --arg role "$role_arn" \
  --arg group "$CODEBUILD_LOG_GROUP" --arg tk "$PROJECT_TAG_KEY" --arg tv "$PROJECT_TAG_VALUE" '{
    name: $name,
    description: "NON-PRODUCTION Moosewave staging images (infra/aws/staging/buildspec-images.yml)",
    source: {type: "S3", location: "\($bucket)/\($prefix)/source/placeholder.zip", buildspec: $buildspec},
    artifacts: {type: "NO_ARTIFACTS"},
    environment: {type: "ARM_CONTAINER", image: $image, computeType: "BUILD_GENERAL1_LARGE",
                  privilegedMode: true, imagePullCredentialsType: "CODEBUILD"},
    serviceRole: $role,
    timeoutInMinutes: 120,
    queuedTimeoutInMinutes: 60,
    logsConfig: {cloudWatchLogs: {status: "ENABLED", groupName: $group}, s3Logs: {status: "DISABLED"}},
    tags: [{key: $tk, value: $tv}]
  }' >"$STAGING_TMP/project.json"
project_count=$(awsx "$BUILD_REGION" codebuild batch-get-projects --names "$CODEBUILD_PROJECT" \
  --query 'length(projects)' --output text)
if [ "$project_count" = 1 ]; then
  project_tag=$(awsx "$BUILD_REGION" codebuild batch-get-projects --names "$CODEBUILD_PROJECT" \
    --query "projects[0].tags[?key=='$PROJECT_TAG_KEY'].value | [0]" --output text)
  require_tagged "CodeBuild project $CODEBUILD_PROJECT" "$project_tag"
  if is_dry_run; then plan "refresh CodeBuild project $CODEBUILD_PROJECT"
  else
    awsx "$BUILD_REGION" codebuild update-project --cli-input-json "file://$STAGING_TMP/project.json" >/dev/null
    log "  refreshed"
  fi
elif is_dry_run; then
  plan "create CodeBuild project $CODEBUILD_PROJECT (ARM_CONTAINER, $CODEBUILD_IMAGE, BUILD_GENERAL1_LARGE, privileged, $CODEBUILD_ROLE_NAME)"
else
  awsx "$BUILD_REGION" codebuild create-project --cli-input-json "file://$STAGING_TMP/project.json" >/dev/null
  log "  created"
fi

# ------------------------------------------------------------------ build
jq -n --arg project "$CODEBUILD_PROJECT" --arg location "$bucket/$source_key" \
  --arg images "$(selected_images | paste -sd, -)" --arg sha "$sha" --arg registry "$registry" \
  --arg region "$APP_REGION" --arg domain "$DOMAIN" --arg dockerhub "$DOCKERHUB_SECRET_ID" \
  --arg bucket "$bucket" --arg digests "$SOURCE_PREFIX/digests" \
  --arg web "$web_selected" --arg key "${CONSENT_SITE_KEY:-}" --arg upload "$upload_origin" \
  --arg assets "$assets_url" '{
    projectName: $project,
    sourceTypeOverride: "S3",
    sourceLocationOverride: $location,
    environmentVariablesOverride: ([
      {name: "IMAGES", value: $images}, {name: "RELEASE_SHA", value: $sha},
      {name: "ECR_REGISTRY", value: $registry}, {name: "ECR_REGION", value: $region},
      {name: "STAGING_DOMAIN", value: $domain}, {name: "DOCKERHUB_SECRET_ID", value: $dockerhub},
      {name: "DIGESTS_BUCKET", value: $bucket}, {name: "DIGESTS_PREFIX", value: $digests}
    ] + (if $web != "1" then [] else [
      {name: "CONSENT_SITE_KEY", value: $key}, {name: "UPLOAD_ORIGIN", value: $upload},
      {name: "ASSETS_BASE_URL", value: $assets}] end)
    | map(. + {type: "PLAINTEXT"}))
  }' >"$STAGING_TMP/start.json"

if is_dry_run; then
  plan "start $CODEBUILD_PROJECT for ${sha:0:12} with IMAGES=$(selected_images | paste -sd, -), wait, and record the digests in $STAGING_STATE_DIR/$DIGESTS_FILE_NAME"
  exit 0
fi

step "starting the build"
build_id=$(awsx "$BUILD_REGION" codebuild start-build --cli-input-json "file://$STAGING_TMP/start.json" \
  --query build.id --output text)
log "  $build_id"
log "  https://$BUILD_REGION.console.aws.amazon.com/codesuite/codebuild/projects/$CODEBUILD_PROJECT/build/$build_id/?region=$BUILD_REGION"
if [ "${NO_WAIT:-0}" = 1 ]; then
  log "NO_WAIT=1: not waiting. The digests will be at s3://$bucket/$SOURCE_PREFIX/digests/${build_id#*:}.env"
  exit 0
fi

step "waiting (a full image set takes about 30-40 minutes)"
last=""
deadline=$(( $(now) + 150 * 60 ))
while :; do
  state=$(awsx "$BUILD_REGION" codebuild batch-get-builds --ids "$build_id" \
    --query 'builds[0].[buildStatus,currentPhase]' --output text)
  status=${state%%[[:space:]]*}
  phase=${state##*[[:space:]]}
  [ "$state" = "$last" ] || log "  $(date -u +%H:%M:%S) $status $phase"
  last=$state
  [ "$status" = IN_PROGRESS ] || break
  [ "$(now)" -lt "$deadline" ] || die "the build is still running after 150 minutes: $build_id"
  sleep 30
done

if [ "$status" != SUCCEEDED ]; then
  log "build $status; the end of its log:"
  POSTWAVE_CI_PROJECT="$CODEBUILD_PROJECT" POSTWAVE_CI_REGION="$BUILD_REGION" \
    "$REPO_ROOT/scripts/ci/aws-ci.sh" --log "$build_id" 2>/dev/null | tail -n 150 >&2 || true
  die "image build $status ($build_id)"
fi

step "digests"
ensure_state_dir
mkdir -p "$STAGING_STATE_DIR/builds"
build_file="$STAGING_STATE_DIR/builds/${build_id#*:}.env"
awsx "$BUILD_REGION" s3api get-object --bucket "$bucket" \
  --key "$SOURCE_PREFIX/digests/${build_id#*:}.env" "$build_file" >/dev/null
if awk 'NF' "$build_file" | grep -Ev '^[a-z-]+=sha256:[0-9a-f]{64}$|^[a-z-]+\.release=[0-9a-f]{40}$' >&2; then
  die "unexpected line(s) above in $build_file"
fi
for image in $(selected_images); do
  grep -q "^$image=sha256:" "$build_file" || die "the build recorded no digest for $image"
done
merge_env_file "$STAGING_STATE_DIR/$DIGESTS_FILE_NAME" "$build_file"
sed 's/^/  /' "$build_file"
log "recorded in $STAGING_STATE_DIR/$DIGESTS_FILE_NAME; deploy.sh services rolls them out"
