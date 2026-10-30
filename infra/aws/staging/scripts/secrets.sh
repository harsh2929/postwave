#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# secrets.sh -- NON-PRODUCTION. Creates and checks the postwave/staging/*
# secrets (Secrets Manager, us-west-2) that the Moosewave staging stacks read.
#
#   secrets.sh bootstrap    create every generated secret that does not exist
#   secrets.sh redis-url    compose postwave/staging/redis-url (after base.yaml)
#   secrets.sh check        report presence, tag and DSN consistency; no values
#   secrets.sh put <name>   store an operator-supplied third-party value, read
#                           from stdin (stripe-*, anthropic-api-key,
#                           ops-slack-webhook-url)
#
# bootstrap is idempotent: an existing secret is never overwritten, a secret
# scheduled for deletion by an earlier teardown is restored, and the three
# database DSNs are composed from their password secrets (host
# db.postwave.internal, sslmode=require). An existing DSN that no longer
# matches its password is reported; RECOMPOSE=1 rewrites it.
# Random values come from `openssl rand`, go to Secrets Manager through a 0600
# temp file, and are never printed. Every secret is tagged
# Project=moosewave-staging (teardown refuses anything untagged).
#
# Environment: DRY_RUN=1 prints what would change and writes nothing;
# RECOMPOSE=1 (bootstrap) rewrites mismatched DSNs; AWS_PROFILE as usual.

# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd -P)/common.sh"

require_cmd jq openssl

readonly DESCRIPTION_PREFIX="moosewave-staging (NON-PRODUCTION)"

secret_file() { mktemp "$STAGING_TMP/secret.XXXXXX"; }

# Writes <file>'s content as the value of postwave/staging/<name>, creating,
# restoring or updating the secret as needed.
store_secret_file() { # <name> <file> <description>
  local name="$1" file="$2" description="$3" id state
  id=$(secret_id "$name")
  state=$(secret_state "$name") || return 1
  case "$state" in
    absent)
      awsx "$APP_REGION" secretsmanager create-secret --name "$id" \
        --description "$DESCRIPTION_PREFIX $description" \
        --secret-string "file://$file" \
        --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" >/dev/null || return 1 ;;
    pending-deletion)
      awsx "$APP_REGION" secretsmanager restore-secret --secret-id "$id" >/dev/null || return 1
      awsx "$APP_REGION" secretsmanager put-secret-value --secret-id "$id" \
        --secret-string "file://$file" >/dev/null || return 1 ;;
    active)
      awsx "$APP_REGION" secretsmanager put-secret-value --secret-id "$id" \
        --secret-string "file://$file" >/dev/null || return 1 ;;
  esac
  rm -f "$file"
  secrets_refresh
}

ensure_tag() { # <name>: an active secret without the Project tag gets it
  local name="$1" tag
  tag=$(secret_tag "$name") || return 1
  [ "$tag" = "$PROJECT_TAG_VALUE" ] && return 0
  if is_dry_run; then
    plan "tag $(secret_id "$name") $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE (it has '${tag:-no tag}')"
    return 0
  fi
  warn "$(secret_id "$name") had no $PROJECT_TAG_KEY=$PROJECT_TAG_VALUE tag; adding it"
  awsx "$APP_REGION" secretsmanager tag-resource --secret-id "$(secret_id "$name")" \
    --tags "Key=$PROJECT_TAG_KEY,Value=$PROJECT_TAG_VALUE" >/dev/null || return 1
  secrets_refresh
}

random_into() { # <hex:N|b64:N> <file>
  local kind="${1%%:*}" bytes="${1#*:}" expected actual
  case "$kind" in
    hex) openssl rand -hex "$bytes" | tr -d '\n' >"$2" || return 1
         expected=$(( bytes * 2 )) ;;
    b64) openssl rand -base64 "$bytes" | tr -d '\n' >"$2" || return 1
         expected=$(( 4 * ((bytes + 2) / 3) )) ;; # base64 length: 4 per started 3 bytes
    *) log "unknown generator $1"; return 1 ;;
  esac
  actual=$(wc -c <"$2" | tr -d ' ')
  [ "$actual" = "$expected" ] || { log "openssl produced $actual characters, expected $expected"; return 1; }
}

is_hex() { printf '%s' "$1" | grep -Eq '^[0-9a-f]+$'; }

compose_dsn() { # <user> <password secret name> -> the DSN (stdout; capture it)
  local password
  password=$(secret_value "$2") || return 1
  is_hex "$password" || { log "$(secret_id "$2") is not hex, so it is not DSN-safe"; return 1; }
  printf 'postgres://%s:%s@%s:5432/postwave?sslmode=require' "$1" "$password" "$DB_HOST"
}

expected_redis_url() { # -> the redis-url value (stdout; capture it)
  local status endpoint port token
  status=$(stack_status "$APP_REGION" "$STACK_BASE") || return 1
  status_is_complete "$status" || { log "stack $STACK_BASE is $status; deploy base.yaml first"; return 1; }
  endpoint=$(stack_output "$APP_REGION" "$STACK_BASE" RedisPrimaryEndpoint) || return 1
  port=$(stack_output "$APP_REGION" "$STACK_BASE" RedisPort) || return 1
  [ -n "$endpoint" ] && [ -n "$port" ] || { log "$STACK_BASE has no RedisPrimaryEndpoint/RedisPort output"; return 1; }
  token=$(secret_value redis-auth-token) || return 1
  printf '%s' "$token" | grep -Eq '^[0-9a-f]{16,128}$' ||
    { log "postwave/staging/redis-auth-token must be 16-128 hex characters"; return 1; }
  printf 'rediss://:%s@%s:%s/0' "$token" "$endpoint" "$port"
}

# ------------------------------------------------------------------ bootstrap
bootstrap() {
  local name generator consumers state file value expected user source source_state mismatches=0
  step "postwave/staging secrets in $APP_REGION (account $(account_id))"
  while IFS='|' read -r name generator consumers; do
    [ -n "$name" ] || continue
    state=$(secret_state "$name")
    case "$generator" in
      hex:*|b64:*)
        case "$state" in
          active) ensure_tag "$name"; log "  exists     $name" ;;
          pending-deletion)
            if is_dry_run; then plan "restore $(secret_id "$name") (scheduled for deletion)"
            else
              awsx "$APP_REGION" secretsmanager restore-secret --secret-id "$(secret_id "$name")" >/dev/null
              secrets_refresh
              ensure_tag "$name"
              log "  restored   $name (kept its earlier value)"
            fi ;;
          absent)
            if is_dry_run; then plan "create $(secret_id "$name") ($generator random)"
            else
              file=$(secret_file)
              random_into "$generator" "$file"
              store_secret_file "$name" "$file" "$consumers secret ($generator random)"
              log "  created    $name"
            fi ;;
        esac ;;
      dsn:*)
        user=$(printf '%s' "$generator" | cut -d: -f2)
        source=$(printf '%s' "$generator" | cut -d: -f3)
        source_state=$(secret_state "$source")
        if is_dry_run && [ "$source_state" != active ]; then
          plan "compose $(secret_id "$name") from $(secret_id "$source") once that exists"
          continue
        fi
        case "$state" in
          active)
            ensure_tag "$name"
            expected=$(compose_dsn "$user" "$source")
            value=$(secret_value "$name")
            if [ "$value" = "$expected" ]; then
              log "  consistent $name"
            elif [ "${RECOMPOSE:-0}" = 1 ]; then
              if is_dry_run; then plan "rewrite $(secret_id "$name") from $(secret_id "$source")"
              else
                file=$(secret_file)
                printf '%s' "$expected" >"$file"
                store_secret_file "$name" "$file" "DSN for $user"
                log "  recomposed $name from $source"
              fi
            else
              log "  MISMATCH   $name does not use the current $source (RECOMPOSE=1 rewrites it)"
              mismatches=$((mismatches + 1))
            fi ;;
          pending-deletion|absent)
            if is_dry_run; then plan "compose $(secret_id "$name") from $(secret_id "$source")"
            else
              file=$(secret_file)
              compose_dsn "$user" "$source" >"$file"
              store_secret_file "$name" "$file" "DSN for $user on $DB_HOST"
              log "  created    $name (from $source)"
            fi ;;
        esac ;;
      redis-url)
        log "  later      $name (needs base.yaml: secrets.sh redis-url, run by deploy.sh)" ;;
      external)
        if [ "$state" = active ]; then ensure_tag "$name"; log "  exists     $name (optional)"
        else log "  optional   $name (not set; secrets.sh put $name to enable it)"; fi ;;
      *) die "unknown generator $generator for $name" ;;
    esac
  done <<EOF
$STAGING_SECRET_SPECS
EOF
  [ "$mismatches" -eq 0 ] || die "$mismatches DSN secret(s) do not match their password secret"
}

# ------------------------------------------------------------------ redis-url
redis_url() {
  local expected current state file
  step "postwave/staging/redis-url"
  expected=$(expected_redis_url)
  state=$(secret_state redis-url)
  if [ "$state" = active ]; then
    ensure_tag redis-url
    current=$(secret_value redis-url)
    if [ "$current" = "$expected" ]; then log "  up to date"; return 0; fi
  fi
  if is_dry_run; then plan "write $(secret_id redis-url) from redis-auth-token and $STACK_BASE"; return 0; fi
  file=$(secret_file)
  printf '%s' "$expected" >"$file"
  store_secret_file redis-url "$file" "REDIS_URL (rediss) for the staging Valkey"
  log "  written"
}

# ---------------------------------------------------------------------- check
check() {
  local name generator consumers state tag problems=0 expected value user source base_status
  step "postwave/staging secrets in $APP_REGION"
  base_status=$(stack_status "$APP_REGION" "$STACK_BASE")
  while IFS='|' read -r name generator consumers; do
    [ -n "$name" ] || continue
    state=$(secret_state "$name")
    tag=$(secret_tag "$name")
    case "$state:$consumers" in
      active:*) ;;
      *:optional) log "  -          $name (optional, not set)"; continue ;;
      *) log "  MISSING    $name ($state)"; problems=$((problems + 1)); continue ;;
    esac
    if [ "$tag" != "$PROJECT_TAG_VALUE" ]; then
      log "  UNTAGGED   $name"; problems=$((problems + 1)); continue
    fi
    case "$generator" in
      dsn:*)
        user=$(printf '%s' "$generator" | cut -d: -f2)
        source=$(printf '%s' "$generator" | cut -d: -f3)
        # A missing or non-hex password is reported here, not fatal, so the
        # check still covers every other secret.
        if ! expected=$(compose_dsn "$user" "$source"); then
          log "  MISMATCH   $name (cannot compose it from $source)"; problems=$((problems + 1)); continue
        fi
        value=$(secret_value "$name")
        if [ "$value" = "$expected" ]; then log "  ok         $name (matches $source)"
        else log "  MISMATCH   $name (does not match $source)"; problems=$((problems + 1)); fi ;;
      redis-url)
        if status_is_complete "$base_status"; then
          if ! expected=$(expected_redis_url); then
            log "  STALE      $name (cannot compose it from $STACK_BASE)"; problems=$((problems + 1)); continue
          fi
          value=$(secret_value "$name")
          if [ "$value" = "$expected" ]; then log "  ok         $name (matches $STACK_BASE)"
          else log "  STALE      $name (secrets.sh redis-url rewrites it)"; problems=$((problems + 1)); fi
        else
          log "  ok         $name (base not deployed; not compared)"
        fi ;;
      *) log "  ok         $name" ;;
    esac
  done <<EOF
$STAGING_SECRET_SPECS
EOF
  [ "$problems" -eq 0 ] || die "$problems secret problem(s)"
  log "all required secrets present"
}

# ------------------------------------------------------------------------ put
put() { # <name>
  local name="${1:-}" generator value file
  [ -n "$name" ] || die "usage: secrets.sh put <name>"
  generator=$(secret_generator "$name")
  [ "$generator" = external ] ||
    die "$name is not an operator-supplied secret (bootstrap generates it)"
  if [ -t 0 ]; then
    printf 'value for %s (not echoed): ' "$(secret_id "$name")" >&2
    IFS= read -r -s value || true
    printf '\n' >&2
  else
    value=$(cat)
  fi
  [ -n "$value" ] || die "empty value"
  case "$name:$value" in
    stripe-secret-key:sk_test_*|stripe-secret-key:rk_test_*) ;;
    stripe-secret-key:*) die "staging takes only Stripe TEST keys (sk_test_ or rk_test_)" ;;
    stripe-webhook:whsec_*) ;;
    stripe-webhook:*) die "a Stripe webhook secret starts with whsec_" ;;
    stripe-price-*:price_*) ;;
    stripe-price-*:*) die "a Stripe price id starts with price_" ;;
    anthropic-api-key:sk-ant-*) ;;
    anthropic-api-key:*) die "an Anthropic API key starts with sk-ant-" ;;
    ops-slack-webhook-url:https://hooks.slack.com/*) ;;
    ops-slack-webhook-url:*) die "a Slack incoming webhook URL starts with https://hooks.slack.com/" ;;
  esac
  if is_dry_run; then plan "store $(secret_id "$name")"; return 0; fi
  file=$(secret_file)
  printf '%s' "$value" >"$file"
  value=""
  store_secret_file "$name" "$file" "operator-supplied $name"
  ensure_tag "$name"
  log "stored $(secret_id "$name"); deploy.sh services passes it to the API"
}

command="${1:-bootstrap}"
case "$command" in
  bootstrap) bootstrap ;;
  redis-url) redis_url ;;
  check) check ;;
  put) shift; put "${1:-}" ;;
  -h|--help|help) usage_from_header "$0" ;;
  *) usage_from_header "$0" >&2; exit 2 ;;
esac
