#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <core|image-services> <immutable-image-ref> [expected-clamav-database-revision]" >&2
  exit 64
}

mode="${1:-}"
image_ref="${2:-}"
expected_database_revision="${3:-}"
case "$mode" in
  core) test -z "$expected_database_revision" || usage ;;
  image-services)
    printf '%s' "$expected_database_revision" | grep -Eq '^[0-9]+$' || usage
    ;;
  *) usage ;;
esac
printf '%s' "$image_ref" | grep -Eq '@sha256:[0-9a-f]{64}$' || {
  echo "image reference must be pinned by sha256 digest" >&2
  exit 65
}

temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT HUP INT TERM

for platform in linux/amd64 linux/arm64; do
  platform_name="${platform#linux/}"
  docker run --rm --platform "$platform" --entrypoint /bin/sh "$image_ref" -ec '
    test "$(id -u)" = 10001
    for binary in campaign-assurance-worker campaign-assurance-image-broker \
      campaign-assurance-model-sandbox campaign-assurance-provider-gateway \
      campaign-assurance-ocr-sandbox campaign-assurance-content-scanner; do
      test -x "/usr/local/bin/${binary}"
    done
    ! command -v postwave-service >/dev/null 2>&1
  '

  if [ "$mode" = core ]; then
    docker run --rm --platform "$platform" --entrypoint /bin/sh "$image_ref" -ec '
      ! command -v tesseract >/dev/null 2>&1
      ! command -v clamscan >/dev/null 2>&1
      ! command -v freshclam >/dev/null 2>&1
      test ! -e /usr/share/tessdata/eng.traineddata
      test ! -e /var/lib/clamav/daily.cvd
      test ! -e /var/lib/clamav/daily.cld
    '
    continue
  fi

  identity="$({
    docker run --rm --platform "$platform" --entrypoint /bin/sh "$image_ref" -ec '
      ! command -v freshclam >/dev/null 2>&1
      test -x /usr/bin/tesseract
      test -x /usr/bin/clamscan
      test -r /usr/share/tessdata/eng.traineddata
      tesseract_version="$(tesseract --version 2>&1 | awk '\''tolower($1) == "tesseract" {print tolower($2); exit}'\'')"
      traineddata_sha256="$(sha256sum /usr/share/tessdata/eng.traineddata | awk '\''{print $1}'\'')"
      clamav_version="$(clamscan --version | awk '\''{split($2, parts, "/"); print tolower(parts[1]) "-db." parts[2]; exit}'\'')"
      printf '\''%s\t%s\n'\'' "${tesseract_version}-eng.sha256.${traineddata_sha256}" "$clamav_version"
    '
  } 2>/dev/null)"
  ocr_identity="${identity%%$'\t'*}"
  scanner_identity="${identity#*$'\t'}"
  printf '%s' "$ocr_identity" | grep -Eq '^[0-9]+([.][0-9]+){1,3}([.-][a-z0-9]+)*-eng[.]sha256[.][0-9a-f]{64}$' || {
    echo "invalid ${platform} OCR identity: ${ocr_identity}" >&2
    exit 66
  }
  printf '%s' "$scanner_identity" | grep -Eq '^[0-9]+([.][0-9]+){1,3}([.-][a-z0-9]+)*-db[.][0-9]{1,12}$' || {
    echo "invalid ${platform} scanner identity: ${scanner_identity}" >&2
    exit 67
  }
  test "${scanner_identity##*-db.}" = "$expected_database_revision" || {
    echo "${platform} scanner database revision does not match the image lock" >&2
    exit 68
  }
  jq -cn --arg platform "$platform" --arg ocr "$ocr_identity" \
    --arg scanner "$scanner_identity" \
    '{platform:$platform,ocr_version:$ocr,scanner_version:$scanner}' \
    > "${temporary_directory}/${platform_name}.json"
done

if [ "$mode" = core ]; then
  jq -cn --arg schema "postwave.campaign-assurance-core-verification.v1" \
    --arg image "$image_ref" \
    '{schema_version:$schema,image:$image,platforms:["linux/amd64","linux/arm64"]}'
  exit 0
fi

jq -s -e '
  length == 2 and
  (map(.platform) | sort) == ["linux/amd64","linux/arm64"] and
  (map(.ocr_version) | unique | length) == 1 and
  (map(.scanner_version) | unique | length) == 1
' "${temporary_directory}/amd64.json" "${temporary_directory}/arm64.json" >/dev/null
jq -s --arg schema "postwave.campaign-assurance-image-services-verification.v1" \
  --arg image "$image_ref" \
  '{schema_version:$schema,image:$image,platforms:.,ocr_version:.[0].ocr_version,scanner_version:.[0].scanner_version}' \
  "${temporary_directory}/amd64.json" "${temporary_directory}/arm64.json"
