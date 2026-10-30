#!/bin/sh
# Build the deterministic manifest embedded in the Moosewave migrator image.
#
# Usage:
#   scripts/release/build-migration-manifest.sh \
#     infra/migrations migration-manifest.sha256 migration-manifest.env

set -eu

MIGRATIONS_DIR="${1:?migrations directory is required}"
MANIFEST_PATH="${2:?manifest output path is required}"
METADATA_PATH="${3:?metadata output path is required}"

fail() {
  printf 'migration manifest: %s\n' "$*" >&2
  exit 1
}

[ -d "${MIGRATIONS_DIR}" ] || fail "directory does not exist: ${MIGRATIONS_DIR}"
SUPERSESSIONS_PATH="${MIGRATIONS_DIR}/checksum-supersessions.json"
[ -f "${SUPERSESSIONS_PATH}" ] || fail "missing checksum supersessions ledger: ${SUPERSESSIONS_PATH}"

manifest_tmp="$(mktemp)"
metadata_tmp="$(mktemp)"
files_tmp="$(mktemp)"
prefixes_tmp="$(mktemp)"
trap 'rm -f "${manifest_tmp}" "${metadata_tmp}" "${files_tmp}" "${prefixes_tmp}"' EXIT

find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' -print \
  | LC_ALL=C sort >"${files_tmp}"

count="$(wc -l <"${files_tmp}" | tr -d '[:space:]')"
case "${count}" in
  ''|0|*[!0-9]*) fail "no *.sql migrations found" ;;
  *) ;;
esac

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

while IFS= read -r path; do
  filename="$(basename "${path}")"
  printf '%s\n' "${filename}" | grep -Eq '^[0-9]{4}_[a-z0-9_]+\.sql$' \
    || fail "invalid migration filename (expected NNNN_snake_case.sql): ${filename}"
  prefix="${filename%%_*}"
  previous_filename="$(awk -v wanted="${prefix}" '$1 == wanted { print $2; exit }' "${prefixes_tmp}")"
  if [ -n "${previous_filename}" ]; then
    # Both 1839 stems shipped before collision enforcement existed and are
    # already recorded under these exact version strings in production. Keep
    # the exception identical to check-migration-numbering.mjs: sorting makes
    # this exact pair deterministic, while any renamed/third collision still
    # fails closed. Renumbering either shipped file would make it look pending.
    case "${prefix}:${previous_filename}:${filename}" in
      1839:1839_email_verification.sql:1839_landing_page_variants.sql) ;;
      *) fail "duplicate numeric migration prefix: ${prefix} (${filename})" ;;
    esac
  fi
  printf '%s %s\n' "${prefix}" "${filename}" >>"${prefixes_tmp}"
  printf '%s  %s\n' "$(sha256_file "${path}")" "${filename}" >>"${manifest_tmp}"
done <"${files_tmp}"

latest_filename="$(basename "$(tail -n 1 "${files_tmp}")")"
latest="${latest_filename%.sql}"
manifest_sha256="$(sha256_file "${manifest_tmp}")"
supersessions_sha256="$(sha256_file "${SUPERSESSIONS_PATH}")"

{
  printf 'MIGRATION_COUNT=%s\n' "${count}"
  printf 'MIGRATION_LATEST=%s\n' "${latest}"
  printf 'MIGRATION_MANIFEST_SHA256=%s\n' "${manifest_sha256}"
  printf 'MIGRATION_SUPERSESSIONS_SHA256=%s\n' "${supersessions_sha256}"
} >"${metadata_tmp}"

mkdir -p "$(dirname "${MANIFEST_PATH}")" "$(dirname "${METADATA_PATH}")"
mv "${manifest_tmp}" "${MANIFEST_PATH}"
mv "${metadata_tmp}" "${METADATA_PATH}"

printf 'migration manifest: count=%s latest=%s sha256=%s\n' \
  "${count}" "${latest}" "${manifest_sha256}"
