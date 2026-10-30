#!/bin/sh
# Fail closed before nginx renders a configuration containing an invalid
# upstream or permissive/malformed frame-ancestor expression.
#
# This file is installed as /docker-entrypoint.d/10-validate-postwave-runtime.envsh
# so the nginx entrypoint SOURCES it: the exports at the bottom have to survive
# into the entrypoint's own environment for the later 20-envsubst-on-templates.sh
# pass to see them. Being sourced has two consequences this file honours:
#   * shell options must not leak into the caller, so all validation happens in
#     a subshell that owns its own `set -eu`;
#   * `exit` here takes the entrypoint down, which is exactly the fail-closed
#     behaviour we want — nginx never starts on an invalid configuration.

postwave_runtime_env=$(
  set -eu

  origin_pattern='^https?://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$'
  https_origin_pattern='^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[1-9][0-9]{0,4})?$'

  api_origin=${POSTWAVE_API_ORIGIN:-}
  if ! printf '%s\n' "$api_origin" | grep -Eq "$origin_pattern"; then
    echo >&2 'audit-portal: POSTWAVE_API_ORIGIN must be an exact HTTP(S) origin without credentials, path, query, fragment, or wildcard'
    exit 78
  fi

  # An explicitly-set-but-empty value is rejected rather than silently defaulted:
  # envsubst would otherwise render `frame-ancestors ` with no source list, which
  # browsers drop as a parse error, and there is no X-Frame-Options fallback in
  # nginx.conf. Unset the variable to get the 'none' default.
  if [ "${POSTWAVE_PORTAL_FRAME_ANCESTORS+set}" = set ] && [ -z "$POSTWAVE_PORTAL_FRAME_ANCESTORS" ]; then
    echo >&2 "audit-portal: POSTWAVE_PORTAL_FRAME_ANCESTORS is set but empty; unset it for the 'none' default"
    exit 78
  fi

  ancestors=${POSTWAVE_PORTAL_FRAME_ANCESTORS:-"'none'"}
  if [ "$ancestors" != "'none'" ]; then
    normalized=''
    for ancestor in $ancestors; do
      if [ "$ancestor" != "'self'" ] && ! printf '%s\n' "$ancestor" | grep -Eq "$https_origin_pattern"; then
        echo >&2 "audit-portal: invalid frame ancestor: $ancestor"
        exit 78
      fi
      if [ -z "$normalized" ]; then
        normalized=$ancestor
      else
        normalized="$normalized $ancestor"
      fi
    done
    if [ -z "$normalized" ]; then
      echo >&2 'audit-portal: POSTWAVE_PORTAL_FRAME_ANCESTORS cannot be empty'
      exit 78
    fi
    ancestors=$normalized
  fi

  printf '%s\n%s\n' "$api_origin" "$ancestors"
) || exit 78

POSTWAVE_API_ORIGIN=$(printf '%s\n' "$postwave_runtime_env" | sed -n '1p')
POSTWAVE_PORTAL_FRAME_ANCESTORS=$(printf '%s\n' "$postwave_runtime_env" | sed -n '2p')
export POSTWAVE_API_ORIGIN
export POSTWAVE_PORTAL_FRAME_ANCESTORS
unset postwave_runtime_env
