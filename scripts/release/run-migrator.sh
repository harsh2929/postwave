#!/bin/sh
# Entrypoint for the immutable Moosewave migrator image. The SQL set and its
# expected count/latest version are baked at build time and checked before any
# database connection is opened. After apply, a second binary proves every DB
# row and checksum exactly matches that manifest.

set -eu

MIGRATIONS_DIR="${POSTWAVE_MIGRATIONS_DIR:-/migrations}"
MANIFEST="${POSTWAVE_MIGRATION_MANIFEST:-/usr/local/share/postwave/migration-manifest.sha256}"
METADATA="${POSTWAVE_MIGRATION_METADATA:-/usr/local/share/postwave/migration-manifest.env}"
SUPERSESSIONS="${POSTWAVE_MIGRATION_SUPERSESSIONS:-${MIGRATIONS_DIR}/checksum-supersessions.json}"
TIMEOUT="${POSTWAVE_MIGRATOR_TIMEOUT:-30m}"

fail() {
  printf 'postwave migrator: %s\n' "$*" >&2
  exit 1
}

: "${DATABASE_URL:?DATABASE_URL is required}"
[ -d "${MIGRATIONS_DIR}" ] || fail "missing migrations directory: ${MIGRATIONS_DIR}"
[ -f "${MANIFEST}" ] || fail "missing release manifest: ${MANIFEST}"
[ -f "${METADATA}" ] || fail "missing release metadata: ${METADATA}"
[ -f "${SUPERSESSIONS}" ] || fail "missing checksum supersessions ledger: ${SUPERSESSIONS}"

metadata_value() {
  key="$1"
  value="$(awk -F= -v wanted="${key}" '$1 == wanted { print substr($0, index($0, "=") + 1) }' "${METADATA}")"
  [ -n "${value}" ] || fail "metadata key ${key} is missing"
  printf '%s' "${value}"
}

EXPECTED_COUNT="$(metadata_value MIGRATION_COUNT)"
EXPECTED_LATEST="$(metadata_value MIGRATION_LATEST)"
EXPECTED_MANIFEST_SHA="$(metadata_value MIGRATION_MANIFEST_SHA256)"
EXPECTED_SUPERSESSIONS_SHA="$(metadata_value MIGRATION_SUPERSESSIONS_SHA256)"

case "${EXPECTED_COUNT}" in
  ''|*[!0-9]*) fail "invalid expected migration count" ;;
esac
case "${EXPECTED_LATEST}" in
  [0-9][0-9][0-9][0-9]_[a-z0-9_]*) ;;
  *) fail "invalid expected latest migration" ;;
esac
case "${EXPECTED_MANIFEST_SHA}" in
  *[!0-9a-f]*) fail "invalid expected manifest checksum" ;;
esac
[ "${#EXPECTED_MANIFEST_SHA}" -eq 64 ] || fail "invalid expected manifest checksum length"
case "${EXPECTED_SUPERSESSIONS_SHA}" in
  *[!0-9a-f]*) fail "invalid expected supersessions checksum" ;;
esac
[ "${#EXPECTED_SUPERSESSIONS_SHA}" -eq 64 ] || fail "invalid expected supersessions checksum length"

actual_manifest_sha="$(sha256sum "${MANIFEST}" | awk '{print $1}')"
[ "${actual_manifest_sha}" = "${EXPECTED_MANIFEST_SHA}" ] \
  || fail "release manifest checksum mismatch"
actual_supersessions_sha="$(sha256sum "${SUPERSESSIONS}" | awk '{print $1}')"
[ "${actual_supersessions_sha}" = "${EXPECTED_SUPERSESSIONS_SHA}" ] \
  || fail "checksum supersessions ledger mismatch"

actual_count="$(find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
[ "${actual_count}" = "${EXPECTED_COUNT}" ] \
  || fail "migration file count ${actual_count} does not match release count ${EXPECTED_COUNT}"

actual_latest="$(find "${MIGRATIONS_DIR}" -maxdepth 1 -type f -name '*.sql' \
  | LC_ALL=C sort | tail -n 1 | sed 's|.*/||; s|\.sql$||')"
[ "${actual_latest}" = "${EXPECTED_LATEST}" ] \
  || fail "latest migration ${actual_latest} does not match release latest ${EXPECTED_LATEST}"

(cd "${MIGRATIONS_DIR}" && sha256sum -c "${MANIFEST}") >/dev/null \
  || fail "one or more baked migration checksums do not match"

set -- --dir "${MIGRATIONS_DIR}" --timeout "${TIMEOUT}"
if [ "${POSTWAVE_MIGRATOR_ALLOW_UNSAFE:-0}" = "1" ]; then
  set -- "$@" --allow-unsafe
fi

if [ "${POSTWAVE_MIGRATOR_DRY_RUN:-0}" = "1" ]; then
  exec /usr/local/bin/postwave-migrate "$@" --dry-run
fi

/usr/local/bin/postwave-migrate "$@"
/usr/local/bin/postwave-verify-migrations \
  --manifest "${MANIFEST}" \
  --supersessions "${SUPERSESSIONS}" \
  --timeout "${POSTWAVE_MIGRATOR_VERIFY_TIMEOUT:-1m}"
/usr/local/bin/postwave-verify-consent-evidence \
  --timeout "${POSTWAVE_CONSENT_EVIDENCE_PREFLIGHT_TIMEOUT:-2m}"
