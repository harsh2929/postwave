#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# smoke.sh -- NON-PRODUCTION. Checks the public face of Moosewave staging from
# the outside, over HTTPS only (no AWS credentials needed).
#
#   smoke.sh [all|tls|api|web]      (default all)
#
#   tls  every public name (staging.moosewave.com, app., api., forms.,
#        archive.) completes a TLS handshake with a certificate valid for that
#        name, and plain HTTP answers with a 301 to the same https URL
#   api  https://api.staging.moosewave.com/api/ready answers 200 with
#        {"status":"ready"}; archive. reaches the API (any answer below 500)
#   web  https://app.staging.moosewave.com/healthz answers 200 with the web
#        health body; the bare name and forms. reach the web (below 500);
#        the web keeps staging out of search engines (X-Robots-Tag noindex,
#        robots.txt disallowing everything)
#
# `api` fits the moment the API is up and the web is not yet built; `all` is
# the check after every deploy and resume. Exit status 1 if any check fails;
# every check runs and is reported either way.

set -Eeuo pipefail
command -v curl >/dev/null || { echo "smoke.sh needs curl" >&2; exit 2; }

readonly DOMAIN=staging.moosewave.com
readonly HOSTS="$DOMAIN app.$DOMAIN api.$DOMAIN forms.$DOMAIN archive.$DOMAIN"
readonly CURL_OPTS="--silent --show-error --max-time 20 --proto =https,http --tlsv1.2"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/moosewave-smoke.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
failures=0

pass() { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }

# fetch <url> [curl args...]: sets CODE, and BODY/HEADERS files; never exits
fetch() {
  local url="$1" rc=0
  shift
  : >"$TMP/body"
  : >"$TMP/headers"
  # shellcheck disable=SC2086 # CURL_OPTS is a fixed option list
  CODE=$(curl $CURL_OPTS -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' "$@" "$url" 2>"$TMP/err") || rc=$?
  if [ "$rc" -ne 0 ]; then
    CODE="curl-exit-$rc ($(tr '\n' ' ' <"$TMP/err" | cut -c1-160))"
  fi
}

check_tls() {
  local host location
  echo "tls and redirects"
  for host in $HOSTS; do
    fetch "https://$host/" --head
    case "$CODE" in
      curl-exit-*) fail "https://$host/ -> $CODE" ;;
      *) pass "https://$host/ certificate valid for $host (HTTP $CODE)" ;;
    esac
    fetch "http://$host/smoke-redirect?x=1" --head
    location=$(tr -d '\r' <"$TMP/headers" | awk 'tolower($1) == "location:" { print $2; exit }')
    # The ALB's redirect keeps host, path and query; it may spell out :443.
    case "$CODE $location" in
      "301 https://$host/smoke-redirect?x=1"|"301 https://$host:443/smoke-redirect?x=1")
        pass "http://$host redirects to https" ;;
      *) fail "http://$host -> $CODE ${location:-no Location}" ;;
    esac
  done
}

check_api() {
  echo "api"
  fetch "https://api.$DOMAIN/api/ready"
  if [ "$CODE" = 200 ] && grep -q '"status":"ready"' "$TMP/body"; then
    pass "api./api/ready is ready"
  else
    fail "api./api/ready -> $CODE $(head -c 120 "$TMP/body" 2>/dev/null)"
  fi
  fetch "https://archive.$DOMAIN/"
  case "$CODE" in
    [1-4][0-9][0-9]) pass "archive. reaches the API (HTTP $CODE)" ;;
    *) fail "archive. -> $CODE" ;;
  esac
}

check_web() {
  local robots_header
  echo "web"
  fetch "https://app.$DOMAIN/healthz"
  if [ "$CODE" = 200 ] && grep -q '"service":"postwave-web"' "$TMP/body"; then
    pass "app./healthz is ok"
  else
    fail "app./healthz -> $CODE $(head -c 120 "$TMP/body" 2>/dev/null)"
  fi
  for host in "$DOMAIN" "forms.$DOMAIN"; do
    fetch "https://$host/"
    case "$CODE" in
      [1-4][0-9][0-9]) pass "$host reaches the web (HTTP $CODE)" ;;
      *) fail "$host -> $CODE" ;;
    esac
  done
  fetch "https://app.$DOMAIN/login" -H 'Accept: text/html'
  robots_header=$(tr -d '\r' <"$TMP/headers" | awk 'tolower($1) == "x-robots-tag:" { $1 = ""; print; exit }')
  case "$robots_header" in
    *noindex*) pass "app./login sends X-Robots-Tag:$robots_header" ;;
    *) fail "app./login has no X-Robots-Tag noindex (HTTP $CODE); is POSTWAVE_PUBLIC_RELEASE_APPROVAL set?" ;;
  esac
  fetch "https://$DOMAIN/robots.txt"
  if [ "$CODE" = 200 ] && tr -d '\r' <"$TMP/body" | grep -qx 'Disallow: /'; then
    pass "robots.txt disallows everything"
  else
    fail "robots.txt -> $CODE without 'Disallow: /'"
  fi
}

case "${1:-all}" in
  all) check_tls; check_api; check_web ;;
  tls) check_tls ;;
  api) check_api ;;
  web) check_web ;;
  -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
  *) echo "usage: smoke.sh [all|tls|api|web]" >&2; exit 2 ;;
esac

if [ "$failures" -eq 0 ]; then
  echo "smoke: all checks passed"
else
  echo "smoke: $failures check(s) failed"
  exit 1
fi
