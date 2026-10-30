#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# codebuild-images.sh -- NON-PRODUCTION. Runs INSIDE the moosewave-staging-images
# CodeBuild build (buildspec-images.yml), from the root of the exported commit.
# Builds the images named in IMAGES for linux/arm64 with BuildKit, pushes them
# to the us-west-2 ECR repositories, and records every pushed digest.
#
#   codebuild-images.sh preflight       validate inputs and target repositories
#   codebuild-images.sh dockerhub-login log in to Docker Hub (DOCKERHUB_SECRET_ID)
#   codebuild-images.sh build           build, check and push the selected images
#   codebuild-images.sh publish         upload digests.env to S3, tagged
#   codebuild-images.sh web-build-args  print the web build args as NAME=VALUE
#
# IMAGES, comma or space separated (default: api-mjml db-migrator clamav listmonk):
#   api          Dockerfile.go target ordinary-service   -> postwave-api:<sha>-plain
#   api-mjml     api + api-mjml.Dockerfile (mjml CLI)     -> postwave-api:<sha>
#                (the api image is built locally first when api is not selected)
#   db-migrator  infra/migrations/Dockerfile              -> postwave-db-migrator:<sha>
#   clamav       clamav.Dockerfile                        -> postwave-clamav:1.4.6-<sha>
#   listmonk     byte-identical copy of the pinned listmonk v6.1.0 index
#                                                         -> postwave-listmonk:v6.1.0
#   web          apps/web/Dockerfile with the staging build args, checked with
#                scripts/release/verify-web-image.sh before the push
#                                                         -> postwave-web:<sha>
#
# Every pushed image prints one line for machines:
#   STAGING_IMAGE name=<name> repository=<repo> tag=<tag> digest=sha256:<hex>
# and adds <name>=<digest> and <name>.release=<sha> to .staging-out/digests.env.
# The digest is read back from ECR, never inferred locally.
#
# Inputs (environment, set by build-images.sh): RELEASE_SHA, ECR_REGISTRY,
# ECR_REGION, IMAGES, STAGING_DOMAIN, DOCKERHUB_SECRET_ID, DIGESTS_BUCKET,
# DIGESTS_PREFIX, and for web CONSENT_SITE_KEY, UPLOAD_ORIGIN, ASSETS_BASE_URL.

set -Eeuo pipefail
trap 'echo "FAILED (exit $?) at codebuild-images.sh line $LINENO: $BASH_COMMAND" >&2' ERR

readonly PLATFORM=linux/arm64
readonly LISTMONK_SOURCE=docker.io/listmonk/listmonk:v6.1.0@sha256:179d00d9553c371b6fe88c9b145095d651e275bdd66db46b2e0b79daff316b6f
readonly LISTMONK_DIGEST=sha256:179d00d9553c371b6fe88c9b145095d651e275bdd66db46b2e0b79daff316b6f
readonly LISTMONK_TAG=v6.1.0
readonly CLAMAV_VERSION=1.4.6
readonly VALID_IMAGES="api api-mjml db-migrator clamav listmonk web"
readonly PROJECT_TAG_KEY=Project PROJECT_TAG_VALUE=moosewave-staging
OUT_DIR=${OUT_DIR:-.staging-out}
IMAGES=${IMAGES:-api-mjml,db-migrator,clamav,listmonk}
STAGING_DOMAIN=${STAGING_DOMAIN:-staging.moosewave.com}
ECR_REGION=${ECR_REGION:-us-west-2}
ASSETS_BASE_URL=${ASSETS_BASE_URL:-https://assets.$STAGING_DOMAIN}

die() { echo "ERROR: $*" >&2; exit 1; }
selected_images() { printf '%s\n' "$IMAGES" | tr -s ', ' '\n' | awk 'NF'; }
is_selected() { selected_images | grep -Fxq "$1"; }
repo_for() {
  case "$1" in
    api|api-mjml) echo postwave-api ;;
    db-migrator) echo postwave-db-migrator ;;
    clamav) echo postwave-clamav ;;
    listmonk) echo postwave-listmonk ;;
    web) echo postwave-web ;;
  esac
}

web_build_args() {
  cat <<EOF
POSTWAVE_WEB_CANONICAL_DOMAIN=$STAGING_DOMAIN
POSTWAVE_RELEASE=${RELEASE_SHA:-}
NEXT_PUBLIC_POSTWAVE_RELEASE=${RELEASE_SHA:-}
NEXT_PUBLIC_SITE_URL=https://$STAGING_DOMAIN
NEXT_PUBLIC_APP_URL=https://app.$STAGING_DOMAIN
NEXT_PUBLIC_DOCS_URL=https://docs.$STAGING_DOMAIN
NEXT_PUBLIC_FORMS_ORIGIN=https://forms.$STAGING_DOMAIN
NEXT_PUBLIC_WEB_VITALS_ENDPOINT=https://api.$STAGING_DOMAIN/api/internal/web-vitals
NEXT_PUBLIC_POSTWAVE_API_BASE_URL=https://api.$STAGING_DOMAIN
NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL=$ASSETS_BASE_URL
NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN=${UPLOAD_ORIGIN:-}
NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY=${CONSENT_SITE_KEY:-}
EOF
}

preflight() {
  local image repo arn tag
  printf '%s' "${RELEASE_SHA:-}" | grep -Eq '^[0-9a-f]{40}$' || die "RELEASE_SHA must be the full 40-hex commit"
  printf '%s' "${ECR_REGISTRY:-}" | grep -Eq "^[0-9]{12}\.dkr\.ecr\.$ECR_REGION\.amazonaws\.com$" ||
    die "ECR_REGISTRY must be <account>.dkr.ecr.$ECR_REGION.amazonaws.com"
  [ -n "$(selected_images)" ] || die "IMAGES is empty"
  for image in $(selected_images); do
    case " $VALID_IMAGES " in *" $image "*) ;; *) die "unknown image '$image' (valid: $VALID_IMAGES)" ;; esac
  done
  if is_selected web; then
    grep -q '^ARG POSTWAVE_WEB_CANONICAL_DOMAIN' apps/web/Dockerfile ||
      die "apps/web/Dockerfile in this commit has no POSTWAVE_WEB_CANONICAL_DOMAIN build arg, so it can only build for moosewave.com; build a commit that includes it"
    printf '%s' "${CONSENT_SITE_KEY:-}" | grep -Eq '^pwk_[0-9a-f]{48}$' ||
      die "CONSENT_SITE_KEY must be the staging pwk_ key (pwk_ + 48 hex)"
    printf '%s' "${UPLOAD_ORIGIN:-}" | grep -Eq "^https://[a-z0-9.-]+\.s3\.$ECR_REGION\.amazonaws\.com$" ||
      die "UPLOAD_ORIGIN must be the uploads bucket's regional origin"
    # The full origin check (apps/web/scripts/check-container-build-env.mjs)
    # runs inside the image build, where the web dependencies it imports are
    # installed; the build host has no node_modules, so it cannot run here.
    # scripts/tests/run.sh runs it against these build args offline.
  fi
  # The repository names are production's too: push only into repositories
  # build-images.sh created and tagged for staging.
  for image in $(selected_images); do
    repo=$(repo_for "$image")
    arn=$(aws ecr describe-repositories --region "$ECR_REGION" --repository-names "$repo" \
      --query 'repositories[0].repositoryArn' --output text) || die "ECR repository $repo is missing (build-images.sh creates it)"
    tag=$(aws ecr list-tags-for-resource --region "$ECR_REGION" --resource-arn "$arn" \
      --query "tags[?Key=='$PROJECT_TAG_KEY'].Value | [0]" --output text)
    [ "$tag" = "$PROJECT_TAG_VALUE" ] || die "refusing to push into $repo: it is not tagged $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE"
  done
  echo "preflight ok: release $RELEASE_SHA, images: $(selected_images | tr '\n' ' ')"
}

dockerhub_login() {
  local creds user password
  if [ -z "${DOCKERHUB_SECRET_ID:-}" ]; then
    echo "DOCKERHUB_SECRET_ID is empty: pulling from Docker Hub anonymously"
    return 0
  fi
  creds=$(aws secretsmanager get-secret-value --secret-id "$DOCKERHUB_SECRET_ID" \
    --query SecretString --output text)
  user=$(printf '%s' "$creds" | jq -r '.username // empty')
  password=$(printf '%s' "$creds" | jq -r '.password // empty')
  creds=""
  [ -n "$user" ] && [ -n "$password" ] || die "$DOCKERHUB_SECRET_ID must be JSON with username and password"
  printf '%s' "$password" | docker login --username "$user" --password-stdin docker.io >/dev/null
  password=""
  echo "logged in to Docker Hub"
}

buildx() { docker buildx build --platform "$PLATFORM" --provenance=false --sbom=false --progress=plain "$@"; }

ecr_digest() { # <repo> <tag>
  aws ecr describe-images --region "$ECR_REGION" --repository-name "$1" \
    --image-ids "imageTag=$2" --query 'imageDetails[0].imageDigest' --output text
}

record() { # <name> <repo> <tag> <digest>
  printf '%s' "$4" | grep -Eq '^sha256:[0-9a-f]{64}$' || die "ECR returned no digest for $2:$3 (got '$4')"
  echo "STAGING_IMAGE name=$1 repository=$2 tag=$3 digest=$4"
  printf '%s=%s\n%s.release=%s\n' "$1" "$4" "$1" "$RELEASE_SHA" >>"$OUT_DIR/digests.env"
}

push() { # <name> <local image> <repo> <tag>
  local remote="$ECR_REGISTRY/$3:$4" digest
  docker tag "$2" "$remote"
  docker push --quiet "$remote" >/dev/null
  digest=$(ecr_digest "$3" "$4")
  record "$1" "$3" "$4" "$digest"
}

API_LOCAL=""
build_api_image() {
  [ -z "$API_LOCAL" ] || return 0
  API_LOCAL="postwave-staging-api:$RELEASE_SHA"
  echo "--- building api (Dockerfile.go target ordinary-service)"
  buildx -f Dockerfile.go --target ordinary-service \
    --build-arg SERVICE_PATH=./apps/api --build-arg SERVICE_PORT=8080 \
    --build-arg HEALTHCHECK_PATH=/api/ready \
    --tag "$API_LOCAL" --load .
}

build_one() { # <image name>
  local local_image args=() line
  case "$1" in
    api)
      build_api_image
      push api "$API_LOCAL" postwave-api "$RELEASE_SHA-plain" ;;
    api-mjml)
      build_api_image
      local_image="postwave-staging-api-mjml:$RELEASE_SHA"
      echo "--- building api-mjml (api + pinned mjml CLI)"
      buildx -f infra/aws/staging/api-mjml.Dockerfile --build-arg "API_IMAGE=$API_LOCAL" \
        --tag "$local_image" --load infra/aws/staging
      push api-mjml "$local_image" postwave-api "$RELEASE_SHA" ;;
    db-migrator)
      local_image="postwave-staging-db-migrator:$RELEASE_SHA"
      echo "--- building db-migrator (infra/migrations/Dockerfile)"
      buildx -f infra/migrations/Dockerfile --tag "$local_image" --load .
      push db-migrator "$local_image" postwave-db-migrator "$RELEASE_SHA" ;;
    clamav)
      local_image="postwave-staging-clamav:$RELEASE_SHA"
      echo "--- building clamav (clamav-debian $CLAMAV_VERSION derived)"
      buildx -f infra/aws/staging/clamav.Dockerfile --tag "$local_image" --load infra/aws/staging
      push clamav "$local_image" postwave-clamav "$CLAMAV_VERSION-$RELEASE_SHA" ;;
    listmonk)
      echo "--- mirroring listmonk $LISTMONK_TAG by digest"
      docker buildx imagetools create --tag "$ECR_REGISTRY/postwave-listmonk:$LISTMONK_TAG" "$LISTMONK_SOURCE"
      local digest
      digest=$(ecr_digest postwave-listmonk "$LISTMONK_TAG")
      [ "$digest" = "$LISTMONK_DIGEST" ] || die "the listmonk mirror has digest $digest, not the pinned $LISTMONK_DIGEST"
      record listmonk postwave-listmonk "$LISTMONK_TAG" "$digest" ;;
    web)
      local_image="postwave-staging-web:$RELEASE_SHA"
      while IFS= read -r line; do args+=(--build-arg "$line"); done <<EOF
$(web_build_args)
EOF
      echo "--- building web (apps/web/Dockerfile for $STAGING_DOMAIN)"
      buildx -f apps/web/Dockerfile "${args[@]}" --tag "$local_image" --load .
      echo "--- web image layers (largest first)"
      docker history --format '{{.Size}}\t{{.CreatedBy}}' "$local_image" | sort -rh | head -8 | cut -c1-160 || true
      echo "--- web image contents in MiB (largest first)"
      docker run --rm --user 0 --entrypoint sh "$local_image" -c \
        'du -sm /app/node_modules/.pnpm/* /app/node_modules/* /app/apps/web/.next/* /app/apps/web/public /app/packages/* 2>/dev/null | sort -rn | head -30' || true
      echo "--- verifying the web image (scripts/release/verify-web-image.sh)"
      POSTWAVE_WEB_IMAGE_PLATFORM="$PLATFORM" bash scripts/release/verify-web-image.sh "$local_image"
      push web "$local_image" postwave-web "$RELEASE_SHA" ;;
  esac
}

build() {
  local image
  mkdir -p "$OUT_DIR"
  : >"$OUT_DIR/digests.env"
  for image in $(selected_images); do build_one "$image"; done
  echo "--- digests"
  cat "$OUT_DIR/digests.env"
}

publish() {
  local key
  [ -s "$OUT_DIR/digests.env" ] || die "no digests were recorded"
  [ -n "${DIGESTS_BUCKET:-}" ] || die "DIGESTS_BUCKET is not set"
  key="${DIGESTS_PREFIX:-moosewave-staging-images/digests}/${CODEBUILD_BUILD_ID#*:}.env"
  aws s3api put-object --bucket "$DIGESTS_BUCKET" --key "$key" \
    --body "$OUT_DIR/digests.env" --content-type text/plain \
    --tagging "$PROJECT_TAG_KEY=$PROJECT_TAG_VALUE" >/dev/null
  echo "STAGING_DIGESTS s3://$DIGESTS_BUCKET/$key"
}

case "${1:-}" in
  preflight) preflight ;;
  dockerhub-login) dockerhub_login ;;
  build) build ;;
  publish) publish ;;
  web-build-args) web_build_args ;;
  *) echo "usage: codebuild-images.sh preflight|dockerhub-login|build|publish|web-build-args" >&2; exit 2 ;;
esac
