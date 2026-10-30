#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# run.sh -- NON-PRODUCTION. Offline tests for infra/aws/staging. No AWS
# account is touched: every script runs against tests/fake-aws, which logs
# each call and, in read-only tests, fails any write call.
#
#   infra/aws/staging/scripts/tests/run.sh
#
# Checks: syntax under /bin/bash (3.2 on macOS) and shellcheck; SPDX headers;
# the secret list against both templates; the web build args against the web
# Dockerfile and its own build check; helper units; dry runs of deploy,
# secrets, teardown, pause and resume making zero write calls; teardown and
# pause refusing untagged resources before any write; deploy's change-set
# handling (no changes, refused replacement, allowed replacement); the smoke
# checks' parsing; the mail and cost-guard security invariants in the
# templates; the scratch-volume init wiring; the database user data's UTF8
# pin; build-images.sh's platform-sender warning (dry run). With Docker: the
# scratch-volume init on the API and web base images, the ClamAV image
# builds, the database-host SQL runs against a real Postgres 16 (both steps, both failure modes), and the real
# listmonk v6.1.0 that staging runs, with no route out, takes a send after the
# listmonk step, delivers nothing and stays up.

set -Eeuo pipefail
TESTS=$(cd "$(dirname "$0")" && pwd -P)
SCRIPTS=$(dirname "$TESTS")
STAGING=$(dirname "$SCRIPTS")
REPO=$(cd "$STAGING/../../.." && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/moosewave-staging-tests.XXXXXX")
PG_CONTAINER=""
LM_CONTAINER=""
LM_NET=""
cleanup() {
  [ -z "$LM_CONTAINER" ] || docker rm -f "$LM_CONTAINER" >/dev/null 2>&1 || true
  [ -z "$PG_CONTAINER" ] || docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  [ -z "$LM_NET" ] || docker network rm "$LM_NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
passed=0
failed=0
ok() { passed=$((passed + 1)); printf 'ok    %s\n' "$1"; }
not_ok() { # <name> [file to show]
  failed=$((failed + 1))
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then tail -n 40 "$2" | sed 's/^/      /'; fi
}
check() { # <name> <command...>: ok when the command succeeds
  local name="$1"
  shift
  if "$@" >"$WORK/check.out" 2>&1; then ok "$name"; else not_ok "$name" "$WORK/check.out"; fi
}

SCRIPT_FILES="common.sh secrets.sh build-images.sh codebuild-images.sh deploy.sh deploy-web-only.sh migrate.sh db-post-migrate.sh pause.sh resume.sh teardown.sh smoke.sh tests/run.sh tests/fake-aws"

# ------------------------------------------------------------------ static
for f in $SCRIPT_FILES; do
  check "bash -n (/bin/bash $(/bin/bash -c 'echo $BASH_VERSION' | cut -d. -f1-2)): $f" /bin/bash -n "$SCRIPTS/$f"
done
if command -v shellcheck >/dev/null; then
  check "shellcheck: all scripts" sh -c "cd '$SCRIPTS' && shellcheck -x -s bash $SCRIPT_FILES"
else
  echo "skip  shellcheck (not installed)"
fi
for f in $SCRIPT_FILES; do
  [ "$f" != common.sh ] || { check "common.sh is a sourced library (not executable)" test ! -x "$SCRIPTS/$f"; continue; }
  check "executable: $f" test -x "$SCRIPTS/$f"
done

spdx_missing() {
  local f
  for f in "$STAGING"/*.yaml "$STAGING"/*.yml "$STAGING"/*.Dockerfile "$STAGING"/*.dockerignore \
      "$STAGING"/README.md "$SCRIPTS"/*.sh "$SCRIPTS"/tests/*; do
    head -n 3 "$f" | grep -q 'SPDX-License-Identifier: AGPL-3.0-only' || echo "$f"
  done
  jq -e '.license == "AGPL-3.0-only"' "$STAGING/mjml/package.json" >/dev/null || echo "mjml/package.json"
}
spdx_ok() { local missing; missing=$(spdx_missing); [ -z "$missing" ] || { echo "$missing"; return 1; }; }
check "SPDX header on every file" spdx_ok

# The secret list in common.sh must match what the templates consume.
secret_spec_names() { # <consumer>
  bash -c ". '$SCRIPTS/common.sh'; secret_names_for $1" | sort
}
services_params() { # <required|optional>: secret names behind *SecretArn parameters
  awk -v want="$1" '
    /^  [A-Za-z]+SecretArn:$/ { inparam = 1; optional = 0; next }
    inparam && /^    Default: ""/ { optional = 1 }
    inparam && /AllowedPattern:/ {
      if (match($0, /postwave\/staging\/[a-z0-9-]+-\[A-Za-z0-9\]/)) {
        name = substr($0, RSTART + 17, RLENGTH - 17 - 12)   # 17: "postwave/staging/", 12: "-[A-Za-z0-9]"
        if ((want == "optional") == optional) print name
      }
      inparam = 0
    }
    /^  [A-Za-z]/ && !/SecretArn:$/ { inparam = 0 }' "$STAGING/services.yaml" | sort
}
base_refs() { # secrets base.yaml reads: IAM secret ARNs and {{resolve:secretsmanager:...}}
  grep -v '^[[:space:]]*#' "$STAGING/base.yaml" | grep -oE '(:secret:|resolve:secretsmanager:)postwave/staging/[a-z0-9-]+' |
    sed 's|.*postwave/staging/||; s/-$//' | awk 'NF' | sort -u
}
secrets_match() {
  diff <(secret_spec_names services) <(services_params required) &&
    diff <(secret_spec_names optional) <(services_params optional) &&
    diff <(secret_spec_names base) <(base_refs) &&
    [ "$(services_params required | wc -l | tr -d ' ')" -gt 20 ]
}
check "secret list = services.yaml required/optional SecretArn params and base.yaml references" secrets_match
param_names_exist() {
  local name param
  for name in $(secret_spec_names services) $(secret_spec_names optional); do
    param=$(bash -c ". '$SCRIPTS/common.sh'; secret_param_name $name")
    grep -q "^  $param:\$" "$STAGING/services.yaml" || { echo "no parameter $param for $name"; return 1; }
  done
}
check "every secret maps to its <Pascal>SecretArn parameter name" param_names_exist

# ------------------------------------------------------ security invariants
# AlertEmail lands verbatim in the SES ForAllValues:StringLike recipient
# condition, so the IAM wildcards must never pass any of the validators.
alert_email_pattern() { # <template>: its AlertEmail AllowedPattern, YAML-unescaped
  awk '/^  AlertEmail:$/ { p = 1; next } p && /^  [A-Za-z]/ { exit }
       p && /AllowedPattern:/ { sub(/^[^"]*"/, ""); sub(/"[^"]*$/, ""); print; exit }' "$STAGING/$1" |
    sed 's/\\\\/\\/g'
}
alert_email_patterns_refuse_wildcards() {
  local t pattern first="" address want got
  for t in base.yaml services.yaml cost-guard-global.yaml cost-guard-regional.yaml; do
    pattern=$(alert_email_pattern "$t")
    [ -n "$pattern" ] || { echo "$t: no AlertEmail AllowedPattern"; return 1; }
    [ -n "$first" ] || first=$pattern
    [ "$pattern" = "$first" ] || { echo "$t: AlertEmail pattern differs from base.yaml's"; return 1; }
  done
  while read -r want address; do
    # CloudFormation applies AllowedPattern as a Java regex; perl reads it the same way.
    got=reject; PATTERN=$first perl -e 'exit(($ARGV[0] =~ /$ENV{PATTERN}/) ? 0 : 1)' "$address" && got=accept
    [ "$got" = "$want" ] || { echo "template pattern: $address should $want"; return 1; }
    got=reject; bash -c '. "$1/common.sh"; valid_email "$2" && exit 0; exit 1' _ "$SCRIPTS" "$address" && got=accept
    [ "$got" = "$want" ] || { echo "valid_email: $address should $want"; return 1; }
  done <<'EOF'
accept owner@example.com
accept first.last+staging@mail.example.co.uk
reject *@*.*
reject ?@*.com
reject *@gmail.com
reject owner@*.com
reject owner@example.c?m
reject owner@example
reject no-at-sign.example.com
EOF
}
if command -v perl >/dev/null; then
  check "AlertEmail: one pattern in all four templates; it and valid_email refuse * and ?" alert_email_patterns_refuse_wildcards
else
  echo "skip  AlertEmail pattern check (perl not installed)"
fi

resource_block() { # <template> <logical id>: that resource's lines
  awk -v id="$2" '$0 == "  " id ":" { p = 1; print; next } p && /^  [A-Za-z]/ { exit } p' "$STAGING/$1"
}
listmonk_egress_ok() {
  local sg rule port want
  sg=$(resource_block base.yaml ListmonkSecurityGroup)
  # Declared egress replaces the default allow-all rule; every port must be
  # HTTPS or DNS, so no SMTP port (25/465/587) can leave the listmonk task.
  printf '%s\n' "$sg" | grep -q '^      SecurityGroupEgress:$' || { echo "no explicit egress: the default allow-all rule stays"; return 1; }
  for port in $(printf '%s\n' "$sg" | sed -n '/SecurityGroupEgress:/,/Tags:/p' | grep -oE 'FromPort: [0-9]+|ToPort: [0-9]+' | awk '{ print $2 }'); do
    case "$port" in 443|53) ;; *) echo "listmonk egress opens port $port"; return 1 ;; esac
  done
  rule=$(resource_block base.yaml ListmonkToDbEgress)
  for want in 'Type: AWS::EC2::SecurityGroupEgress' 'GroupId: !Ref ListmonkSecurityGroup' \
      'DestinationSecurityGroupId: !Ref DbSecurityGroup' 'FromPort: 5432' 'ToPort: 5432'; do
    if ! printf '%s\n' "$rule" | grep -qF "$want"; then
      echo "ListmonkToDbEgress lacks '$want' (it must be 5432 to the database group only)"
      return 1
    fi
  done
}
check "listmonk security group: HTTPS and DNS out, Postgres only to the database group, no SMTP" listmonk_egress_ok
ses_recipients_guarded() {
  local statement
  statement=$(resource_block base.yaml ApiTaskRole | sed -n '/Sid: SendStagingMail/,/Sid: ReadSesQuota/p')
  printf '%s\n' "$statement" | grep -q '"Null": {"ses:Recipients": "false"}' || { echo "SendStagingMail has no Null guard on ses:Recipients"; return 1; }
  printf '%s\n' "$statement" | grep -q '"ForAllValues:StringLike":' || { echo "SendStagingMail lost its recipient allowlist"; return 1; }
}
check "API SES statement: recipient allowlist plus a Null guard (no recipient-less sends)" ses_recipients_guarded
unexpected_rule_split() {
  # Branches of the rule's $or: resources staging never creates must match
  # every caller; only the ones it creates through CloudFormation may skip it.
  resource_block cost-guard-regional.yaml UnexpectedResourceRule | awk '
    /^          \$or:$/ { inor = 1; next }
    inor && !/^            / && !/^[[:space:]]*(#|$)/ { inor = 0 }
    inor && /- eventName:/ { n++; names[n] = $0 }
    inor && /sourceIPAddress:/ { cfn[n] = 1 }
    END {
      if (n != 2) { print "expected two $or branches, found " n; exit 1 }
      for (i = 1; i <= n; i++) {
        if (cfn[i]) { excluded = excluded names[i] } else { every = every names[i] }
      }
      split("CreateNatGateway CreateDBInstance CreateDBCluster CreateServerlessCache", never, " ")
      for (k in never) if (index(every, never[k]) == 0 || index(excluded, never[k]) > 0) { print never[k] " must alert on every caller"; exit 1 }
      split("RunInstances CreateLoadBalancer CreateCacheCluster CreateReplicationGroup", own, " ")
      for (k in own) if (index(excluded, own[k]) == 0) { print own[k] " must alert on non-CloudFormation callers"; exit 1 }
    }'
}
check "unexpected-resource rule: CloudFormation is exempt only for what staging creates" unexpected_rule_split
keepalive_order_ok() {
  # The ALB reuses pooled connections to its targets. A target that closes an
  # idle keep-alive connection before the ALB does turns the ALB's next request
  # on it into an ALB-generated 502, so every target's keep-alive must outlast
  # the ALB's idle timeout; and the idle timeout must outlast the API's write
  # timeout, or the ALB cuts off a bounded synchronous response.
  local idle web_keepalive_ms api_idle api_write
  idle=$(resource_block base.yaml Alb | grep -oE 'idle_timeout\.timeout_seconds, Value: "[0-9]+"' | grep -oE '[0-9]+')
  web_keepalive_ms=$(resource_block services.yaml WebTaskDefinition | grep -oE 'Name: KEEP_ALIVE_TIMEOUT, Value: "[0-9]+"' | grep -oE '[0-9]+')
  api_idle=$(grep -oE 'IdleTimeout: +[0-9]+ \* time\.Second' "$REPO/apps/api/main.go" | grep -oE '[0-9]+' | head -n 1)
  api_write=$(grep -oE 'const apiWriteTimeout = [0-9]+ \* time\.Second' "$REPO/apps/api/main.go" | grep -oE '[0-9]+' | head -n 1)
  for value in "$idle" "$web_keepalive_ms" "$api_idle" "$api_write"; do
    [ -n "$value" ] || { echo "could not read ALB idle ($idle), web KEEP_ALIVE_TIMEOUT ($web_keepalive_ms), API IdleTimeout ($api_idle) or API write timeout ($api_write)"; return 1; }
  done
  [ "$idle" -gt "$api_write" ] || { echo "ALB idle ${idle}s must exceed the API write timeout (${api_write}s)"; return 1; }
  [ $((web_keepalive_ms / 1000)) -gt "$idle" ] || { echo "web KEEP_ALIVE_TIMEOUT ${web_keepalive_ms}ms must exceed the ALB idle ${idle}s"; return 1; }
  [ "$api_idle" -gt "$idle" ] || { echo "API IdleTimeout ${api_idle}s must exceed the ALB idle ${idle}s"; return 1; }
}
check "keep-alive ordering: API write timeout < ALB idle < web and API keep-alive" keepalive_order_ok

web_args_declared() {
  local line name
  while IFS= read -r line; do
    name=${line%%=*}
    grep -q "^ARG $name\(=\|\$\)" "$REPO/apps/web/Dockerfile" || { echo "apps/web/Dockerfile declares no ARG $name"; return 1; }
  done <<EOF
$(bash "$SCRIPTS/codebuild-images.sh" web-build-args)
EOF
}
check "every web build arg is an ARG of apps/web/Dockerfile" web_args_declared
web_args_pass_build_check() {
  local envs=() line
  while IFS= read -r line; do envs+=("$line"); done <<EOF
$(RELEASE_SHA=0123456789abcdef0123456789abcdef01234567 \
  CONSENT_SITE_KEY=pwk_0123456789abcdef0123456789abcdef0123456789abcdef \
  UPLOAD_ORIGIN=https://postwave-staging-uploads-111122223333.s3.us-west-2.amazonaws.com \
  bash "$SCRIPTS/codebuild-images.sh" web-build-args)
EOF
  (cd "$REPO" && env -i PATH="$PATH" NODE_ENV=production POSTWAVE_ENV=production \
    NEXT_PUBLIC_POSTWAVE_ENV=production "${envs[@]}" node apps/web/scripts/check-container-build-env.mjs)
}
if command -v node >/dev/null; then
  check "web build args pass apps/web/scripts/check-container-build-env.mjs" web_args_pass_build_check
else
  echo "skip  web build check (node not installed)"
fi

# --------------------------------------------------------- scratch volumes
# Fargate creates a task's empty scratch volumes root-owned, mode 0755,
# unless the image has a VOLUME for the path; the API and web images have
# none and run as uid 10001. So each task's first container must be the
# non-essential, root ScratchVolumes init over exactly the main container's
# mounts, and the main container (uid 10001) must wait for it to succeed.
scratch_report() { # <task definition logical id>: key=value lines
  resource_block services.yaml "$1" | awk '
    /^        - Name: / { c = $3; n++; if (n == 1) first = c; next }
    c == "" { next }
    /ContainerPath: / { p = $0; sub(/.*ContainerPath: /, "", p); sub(/[,}].*/, "", p); paths[c] = paths[c] " " p }
    /Name: SCRATCH_DIRS,/ { d = $0; sub(/.*Value: "/, "", d); sub(/".*/, "", d); dirs = d }
    /^          Essential: false$/ { flag[c] = flag[c] "nonessential," }
    /^          User: "0"$/ { flag[c] = flag[c] "root," }
    /^          User: "10001:10001"$/ { flag[c] = flag[c] "uid10001," }
    /Command: \[!FindInMap \[ScratchVolumes, Init, Script\]\]/ { flag[c] = flag[c] "script," }
    /DependsOn: \[\{ContainerName: scratch-permissions, Condition: SUCCESS\}\]/ { flag[c] = flag[c] "waits," }
    END {
      printf "containers=%d\nfirst=%s\ndirs=%s\n", n, first, dirs
      for (k in paths) printf "paths.%s=%s\n", k, paths[k]
      for (k in flag) printf "flags.%s=%s\n", k, flag[k]
    }'
}
words_sorted() { tr ' ' '\n' | awk 'NF' | sort | tr '\n' ' '; }
kv() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; } # <key=value lines> <key>
scratch_wiring_ok() {
  local td report main dirs want
  for td in ApiTaskDefinition WebTaskDefinition; do
    report=$(scratch_report "$td")
    [ "$(kv "$report" containers)" = 2 ] && [ "$(kv "$report" first)" = scratch-permissions ] ||
      { echo "$td: expected scratch-permissions first, then the main container"; printf '%s\n' "$report"; return 1; }
    main=$(printf '%s\n' "$report" | sed -n 's/^flags\.\([a-z-]*\)=.*/\1/p' | grep -v '^scratch-permissions$' | head -n 1)
    [ "$(kv "$report" flags.scratch-permissions)" = nonessential,root,script, ] ||
      { echo "$td: scratch-permissions must be non-essential, run as root and run the ScratchVolumes script"; return 1; }
    case "$(kv "$report" "flags.$main")" in *waits,*) ;; *) echo "$td: $main does not wait for scratch-permissions SUCCESS"; return 1 ;; esac
    case "$(kv "$report" "flags.$main")" in *uid10001,*) ;; *) echo "$td: $main does not run as 10001:10001"; return 1 ;; esac
    dirs=$(kv "$report" dirs | tr ' ' '\n' | sed 's/:[0-7]*$//' | words_sorted)
    want=$(kv "$report" "paths.$main" | words_sorted)
    [ -n "$want" ] && [ "$(kv "$report" paths.scratch-permissions | words_sorted)" = "$want" ] && [ "$dirs" = "$want" ] ||
      { echo "$td: $main mounts '$want'; the init mounts '$(kv "$report" paths.scratch-permissions)' and fixes '$(kv "$report" dirs)'"; return 1; }
  done
  # The script finds uid 10001 by name in /etc/passwd: both images create it.
  if ! grep -q 'adduser -S -u 10001 ' "$REPO/Dockerfile.go" || ! grep -q 'adduser -S -u 10001 ' "$REPO/apps/web/Dockerfile"; then
    echo "an image no longer creates uid 10001"
    return 1
  fi
}
check "scratch volumes: api and web run the root init over the main container's mounts and wait for it" scratch_wiring_ok

db_user_data() { # base.yaml's DbInstance user data, rendered as CloudFormation would
  # shellcheck disable=SC2016 # the ${...} are CloudFormation references, replaced literally
  awk '/^ +Fn::Base64: !Sub \|$/ { p = 1; next } p && /^  [A-Za-z]/ { exit } p' "$STAGING/base.yaml" |
    sed -e 's/^          //' -e 's/\${AWS::Region}/us-west-2/g' -e 's/\${AWS::StackName}/moosewave-staging-base/g' \
      -e 's|\${VpcCidr}|172.31.0.0/16|g'
}
db_user_data_ok() {
  local ud
  ud=$(db_user_data)
  [ "$(printf '%s\n' "$ud" | head -n 1)" = '#!/bin/bash' ] || { echo "found no DbInstance user data"; return 1; }
  printf '%s\n' "$ud" | bash -n || { echo "the rendered user data does not parse"; return 1; }
  # A C-locale host would initdb a SQL_ASCII cluster, and migration 1783 then
  # stops the migrator: the encoding is pinned before initdb and verified
  # before the success signal.
  printf '%s\n' "$ud" | awk '
    /^export PGSETUP_INITDB_OPTIONS=.*--encoding=UTF8/ { pin = NR }
    /postgresql-setup --initdb/ { init = NR }
    /\[ "\$enc" = UTF8:0 \] \|\| fail/ { verify = NR }
    /^signal SUCCESS/ { success = NR }
    END { exit !(pin && init && verify && success && pin < init && init < verify && verify < success) }' ||
    { echo "UTF8 is not pinned before initdb and verified before signal SUCCESS"; return 1; }
}
check "database user data: parses, pins UTF8 before initdb and verifies it before signalling SUCCESS" db_user_data_ok

# -------------------------------------------------------------------- units
units() {
  bash -c '
    set -euo pipefail
    . "'"$SCRIPTS"'/common.sh"
    [ "$(secret_param_name shopify-webhook-secret)" = ShopifyWebhookSecretSecretArn ]
    [ "$(secret_param_name listmonk-ui-admin-password)" = ListmonkUiAdminPasswordSecretArn ]
    [ "$(endpoint_for cloudformation us-west-2)" = https://cloudformation.us-west-2.api.aws ]
    [ "$(endpoint_for s3api us-east-1)" = https://s3.dualstack.us-east-1.amazonaws.com ]
    [ "$(endpoint_for route53 us-east-1)" = https://route53.global.api.aws ]
    [ -z "$(endpoint_for secretsmanager us-west-2)" ]
    [ -z "$(STAGING_AWS_ENDPOINTS=default endpoint_for ecs us-west-2)" ]
    [ "$AWS_USE_DUALSTACK_ENDPOINT" = false ]
    f="$STAGING_TMP/cumulative" n="$STAGING_TMP/new"
    printf "api-mjml=old\napi-mjml.release=r1\nclamav=keep\n" >"$f"
    printf "api-mjml=new\napi-mjml.release=r2\nweb=w\n" >"$n"
    merge_env_file "$f" "$n"
    [ "$(cat "$f")" = "$(printf "clamav=keep\napi-mjml=new\napi-mjml.release=r2\nweb=w")" ]
    merge_env_file "$STAGING_TMP/fresh" "$n"
    [ "$(cat "$STAGING_TMP/fresh")" = "$(cat "$n")" ]
    STAGING_STATE_DIR="$STAGING_TMP"; cp "$f" "$STAGING_TMP/digests.env"
    [ "$(state_digest api-mjml)" = new ] && [ "$(state_digest web)" = w ] && [ -z "$(state_digest api)" ]
    [ "$(printf "%s\n" "$STAGING_SECRET_SPECS" | awk -F"|" "NF == 3" | wc -l | tr -d " ")" = 40 ]
  '
}
check "helpers: parameter names, endpoints, digest merge, spec count" units
images_split() {
  local got
  got=$(IMAGES='api-mjml, clamav,,web listmonk' bash -c "$(sed -n '/^selected_images()/p' "$SCRIPTS/codebuild-images.sh")"'
    selected_images' | tr '\n' ' ')
  [ "$got" = 'api-mjml clamav web listmonk ' ] || { echo "got '$got'"; return 1; }
}
check "codebuild-images.sh splits IMAGES on commas and spaces" images_split

# --------------------------------------------------------------- fake AWS
new_state() { # <name> -> a fresh scenario directory
  local d="$WORK/state.$1"
  rm -rf "$d"
  mkdir -p "$d/stacks" "$d/repos" "$d/buckets" "$d/home"
  : >"$d/calls.log"
  printf '%s\n' "$d"
}
RC=0
run_script() { # <state> <read-only 0|1> <command...>: output in $WORK/out, status in RC
  local state="$1" readonly_flag="$2"
  shift 2
  RC=0
  env STAGING_AWS_BIN="$TESTS/fake-aws" FAKE_AWS_STATE="$state" FAKE_AWS_READONLY="$readonly_flag" \
    STAGING_STATE_DIR="$state/local" HOME="$state/home" ALERT_EMAIL=owner@example.com \
    STACK_POLL_SECONDS=0 "$@" >"$WORK/out" 2>&1 </dev/null || RC=$?
}
writes() { grep -c '^WRITE ' "$1/calls.log" || true; }
out_has() { grep -q -- "$1" "$WORK/out"; }
stack_fixture() { # <state> <stack> <status> [outputs json] [params json] [tag]
  jq -n --arg n "$2" --arg s "$3" --argjson o "${4:-[]}" --argjson p "${5:-[]}" --arg t "${6-moosewave-staging}" '
    {Stacks: [{StackName: $n, StackStatus: $s,
      Description: "NON-PRODUCTION Moosewave staging test stack",
      Tags: (if $t == "" then [] else [{Key: "Project", Value: $t}] end),
      Outputs: $o, Parameters: $p}]}' >"$1/stacks/$2.json"
}
outputs() { # key=value ... -> CloudFormation Outputs JSON
  local kv
  for kv in "$@"; do jq -n --arg k "${kv%%=*}" --arg v "${kv#*=}" '{OutputKey: $k, OutputValue: $v}'; done | jq -s .
}
params() { # key=value ... -> CloudFormation Parameters JSON
  local kv
  for kv in "$@"; do jq -n --arg k "${kv%%=*}" --arg v "${kv#*=}" '{ParameterKey: $k, ParameterValue: $v}'; done | jq -s .
}
secrets_fixture() { # <state> <tag> <name>...
  local state="$1" tag="$2"
  shift 2
  printf '%s\n' "$@" | jq -R --arg t "$tag" '{Name: ("postwave/staging/" + .),
    ARN: ("arn:aws:secretsmanager:us-west-2:111122223333:secret:postwave/staging/" + . + "-AbC123"),
    Tags: [{Key: "Project", Value: $t}]}' | jq -s '{SecretList: .}' >"$state/secrets.json"
}
deployed_fixture() { # <state>: a complete, running, correctly tagged environment
  local s="$1" repo
  stack_fixture "$s" moosewave-staging-base UPDATE_COMPLETE "$(outputs ClusterName=postwave-staging \
    DbInstanceId=i-0123456789abcdef0 UploadsBucketName=postwave-staging-uploads-111122223333 \
    AssetsBucketName=postwave-staging-assets-111122223333 ExportsBucketName=postwave-staging-exports-111122223333 \
    TaskSubnetIds=subnet-0aaaa,subnet-0bbbb RedisPrimaryEndpoint=master.valkey.example RedisPort=6379 \
    MigratorNetworkConfiguration=x MigratorLogGroupName=/ecs/postwave-staging/migrator \
    AlbFullName=app/postwave-staging-alb/0123456789abcdef CacheClusterId=postwave-staging-valkey-001)" \
    "$(params HostedZoneId=ZFAKEZONE VpcId=vpc-0fake SesRegion=eu-west-1 DbInstanceType=t4g.small)"
  stack_fixture "$s" moosewave-staging-services UPDATE_COMPLETE "$(outputs MigratorTaskDefinitionArn=arn:td/m:1 \
    MigratorContainerName=postwave-db-migrator DeployState=x)" \
    "$(params DeployClamav=true DeployListmonk=true DeployApi=true DeployWeb=false \
      MigratorImageDigest=sha256:1111111111111111111111111111111111111111111111111111111111111111)"
  stack_fixture "$s" moosewave-staging-ses UPDATE_COMPLETE "$(outputs SesTopicArns=arn:a,arn:b)" "$(params HostedZoneId=ZFAKEZONE)"
  stack_fixture "$s" moosewave-staging-cost-regional UPDATE_COMPLETE
  stack_fixture "$s" moosewave-staging-cost-global UPDATE_COMPLETE
  for repo in postwave-api postwave-web postwave-db-migrator postwave-clamav postwave-listmonk; do
    echo moosewave-staging >"$s/repos/$repo"
  done
  for repo in uploads assets exports; do echo moosewave-staging >"$s/buckets/postwave-staging-$repo-111122223333"; done
  echo moosewave-staging >"$s/cluster_tag"
  echo '{"InstanceId":"i-0123456789abcdef0","State":{"Name":"running"},"Tags":[{"Key":"Project","Value":"moosewave-staging"}]}' >"$s/instance.json"
  jq -n '{services: [("postwave-clamav","postwave-listmonk","postwave-api","postwave-web") as $n |
    {serviceName: $n, status: "ACTIVE", desiredCount: (if $n == "postwave-web" then 0 else 1 end),
     runningCount: 1, deployments: [{}], tags: [{key: "Project", value: "moosewave-staging"}]}]}' >"$s/services.json"
  secrets_fixture "$s" moosewave-staging db-app-password api-key-pepper redis-auth-token
}

# A web-only rollout must be possible while the API keeps its old template,
# and must reject a change set that unexpectedly touches the API.
s=$(new_state web-only)
deployed_fixture "$s"
web_digest="sha256:$(printf '2%.0s' {1..64})"
web_release=$(printf '2%.0s' {1..40})
stack_fixture "$s" moosewave-staging-services UPDATE_COMPLETE \
  "$(outputs MigratorTaskDefinitionArn=arn:td/m:1)" \
  "$(params DeployApi=true DeployWeb=true WebImageDigest="sha256:$(printf '1%.0s' {1..64})" ReleaseId="$(printf '1%.0s' {1..40})")"
mkdir -p "$s/local"
printf 'web=%s\nweb.release=%s\n' "$web_digest" "$web_release" >"$s/local/digests.env"
jq -n --arg release "$web_release" '{imageDetails: [{imageTags: [$release]}]}' >"$s/images.json"
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/deploy-web-only.sh"
if [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] &&
   out_has 'using the deployed moosewave-staging-services template'; then
  ok "deploy-web-only.sh dry run verifies the image and writes nothing"
else
  not_ok "deploy-web-only.sh dry run [rc=$RC writes=$(writes "$s")]" "$WORK/out"
fi
jq -n '{Status: "CREATE_COMPLETE", Changes: [
  {ResourceChange: {LogicalResourceId: "WebTaskDefinition", Action: "Modify", Replacement: "True"}},
  {ResourceChange: {LogicalResourceId: "ApiTaskDefinition", Action: "Modify", Replacement: "True"}}
]}' >"$s/changeset.json"
run_script "$s" 0 "$SCRIPTS/deploy-web-only.sh"
if [ "$RC" != 0 ] && out_has 'refusing a non-web' &&
   grep -q '^WRITE cloudformation delete-change-set' "$s/calls.log" &&
   ! grep -q '^WRITE cloudformation execute-change-set' "$s/calls.log"; then
  ok "deploy-web-only.sh deletes a change set that touches the API"
else
  not_ok "deploy-web-only.sh non-web change-set guard [rc=$RC]" "$WORK/out"
fi

# Dodo is optional while the API is intentionally stopped, but an API deploy
# must never receive only part of the credential/product tuple. This catches
# the host-side error before CloudFormation sees a misleading partial plan.
s=$(new_state deploy-partial-dodo)
deployed_fixture "$s"
# shellcheck disable=SC2046 # secret_names_for intentionally expands one name per line.
secrets_fixture "$s" moosewave-staging \
  $(bash -c ". '$SCRIPTS/common.sh'; secret_names_for services") \
  redis-url dodo-payments-api-key
mkdir -p "$s/values"
printf '%s' '0123456789abcdef0123456789abcdef' >"$s/values/postwave_staging_redis-auth-token"
printf '%s' 'rediss://:0123456789abcdef0123456789abcdef@master.valkey.example:6379/0' \
  >"$s/values/postwave_staging_redis-url"
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/deploy.sh" services
if [ "$RC" = 1 ] && [ "$(writes "$s")" = 0 ] &&
   out_has 'Dodo Payments needs all 5' && out_has 'secrets; 1 exist'; then
  ok "deploy.sh refuses a partial Dodo Payments secret set before any write"
else
  not_ok "deploy.sh partial Dodo Payments set [rc=$RC writes=$(writes "$s")]" "$WORK/out"
fi

# 1. deploy.sh all, dry run, empty account.
s=$(new_state deploy-dry)
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/deploy.sh" all
if [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] &&
   [ "$(grep -c 'would create a CREATE change set' "$WORK/out")" = 6 ] &&
   out_has 'moosewave-staging-base (us-west-2): CREATE' && out_has 'SubnetIdA = subnet-0aaaa' &&
   out_has 'DbImageId = ami-0123456789abcdef0' && out_has 'AlertEmail = (ALERT_EMAIL)' &&
   ! grep -q 'owner@example.com' "$WORK/out" && out_has 'a real run would stop here'; then
  ok "deploy.sh all (DRY_RUN, empty account): full plan, owner email masked, zero write calls"
else
  not_ok "deploy.sh all (DRY_RUN, empty account) [rc=$RC writes=$(writes "$s")]" "$WORK/out"
fi

# 2. deploy.sh refuses to run without ALERT_EMAIL.
s=$(new_state deploy-noemail)
RC=0
env STAGING_AWS_BIN="$TESTS/fake-aws" FAKE_AWS_STATE="$s" FAKE_AWS_READONLY=1 STAGING_STATE_DIR="$s/local" \
  HOME="$s/home" ALERT_EMAIL= DRY_RUN=1 "$SCRIPTS/deploy.sh" cost-global >"$WORK/out" 2>&1 || RC=$?
if [ "$RC" != 0 ] && out_has 'set ALERT_EMAIL'; then ok "deploy.sh stops without ALERT_EMAIL"
else not_ok "deploy.sh stops without ALERT_EMAIL [rc=$RC]" "$WORK/out"; fi

# 3. secrets.sh bootstrap, dry run, empty account.
s=$(new_state secrets-dry)
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/secrets.sh" bootstrap
if [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] &&
   [ "$(grep -c 'would create postwave/staging/' "$WORK/out")" = 24 ] &&
   [ "$(grep -c 'would compose postwave/staging/' "$WORK/out")" = 3 ]; then
  ok "secrets.sh bootstrap (DRY_RUN): 24 random + 3 composed planned, zero write calls"
else
  not_ok "secrets.sh bootstrap (DRY_RUN) [rc=$RC writes=$(writes "$s")]" "$WORK/out"
fi

# 3b. secrets.sh bootstrap for real (the fake stores values), then again.
s=$(new_state secrets-real)
run_script "$s" 0 "$SCRIPTS/secrets.sh" bootstrap
value() { cat "$s/values/postwave_staging_$1"; }
secrets_real_ok() {
  [ "$RC" = 0 ] || { echo "rc=$RC"; return 1; }
  [ "$(grep -c '^WRITE secretsmanager create-secret' "$s/calls.log")" = 27 ] || { echo "creates: $(grep -c create-secret "$s/calls.log")"; return 1; }
  [ "$(jq '[.SecretList[] | select((.Tags // []) | any(.Key == "Project" and .Value == "moosewave-staging"))] | length' "$s/secrets.json")" = 27 ] || { echo "untagged secret"; return 1; }
  [ "$(value db-dsn)" = "postgres://postwave_app:$(value db-app-password)@db.postwave.internal:5432/postwave?sslmode=require" ] || { echo "db-dsn"; return 1; }
  [ "$(value ops-db-dsn)" = "postgres://postwave_ops:$(value db-ops-password)@db.postwave.internal:5432/postwave?sslmode=require" ] || { echo "ops-db-dsn"; return 1; }
  [ "$(value migration-db-dsn)" = "postgres://postgres:$(value db-postgres-password)@db.postwave.internal:5432/postwave?sslmode=require" ] || { echo "migration-db-dsn"; return 1; }
  printf '%s' "$(value db-app-password)" | grep -Eqx '[0-9a-f]{64}' || { echo "db-app-password shape"; return 1; }
  printf '%s' "$(value metrics-token)" | grep -Eqx '[0-9a-f]{96}' || { echo "metrics-token shape"; return 1; }
  printf '%s' "$(value listmonk-ui-admin-password)" | grep -Eqx '[0-9a-f]{48}' || { echo "listmonk-ui-admin-password shape"; return 1; }
  [ "$(value auth-hmac-pepper | openssl base64 -d -A | wc -c | tr -d ' ')" = 64 ] || { echo "auth-hmac-pepper is not base64 of 64 bytes"; return 1; }
  [ "$(value sending-kek | openssl base64 -d -A | wc -c | tr -d ' ')" = 32 ] || { echo "sending-kek is not base64 of 32 bytes"; return 1; }
  [ "$(value consent-cursor-signing-key)" != "$(value sms-inbox-cursor-key)" ] || { echo "cursor keys equal"; return 1; }
  # No value may appear on a command line (calls.log) or in the output.
  for f in "$s"/values/*; do
    v=$(cat "$f")
    if grep -Fq -- "$v" "$s/calls.log" || grep -Fq -- "$v" "$WORK/out"; then echo "value of ${f##*/} leaked"; return 1; fi
  done
}
if secrets_real_ok >"$WORK/check.out" 2>&1; then
  ok "secrets.sh bootstrap: 27 tagged secrets, right shapes, DSNs built from their passwords, no value on argv or in output"
else not_ok "secrets.sh bootstrap (real, fake store)" "$WORK/check.out"; cat "$WORK/out" >>"$WORK/check.out"; fi
cp "$s/calls.log" "$WORK/calls.first"
run_script "$s" 0 "$SCRIPTS/secrets.sh" bootstrap
if [ "$RC" = 0 ] && [ "$(grep -c '^WRITE' "$s/calls.log")" = "$(grep -c '^WRITE' "$WORK/calls.first")" ] &&
   [ "$(grep -c 'consistent' "$WORK/out")" = 3 ]; then
  ok "secrets.sh bootstrap again: no writes, the three DSNs consistent"
else not_ok "secrets.sh bootstrap rerun [rc=$RC]" "$WORK/out"; fi
run_script "$s" 1 "$SCRIPTS/secrets.sh" check
if [ "$RC" = 1 ] && out_has 'MISSING    redis-url' && out_has 'ERROR: 1 secret problem' &&
   [ "$(grep -c '(matches ' "$WORK/out")" = 3 ]; then
  ok "secrets.sh check: only redis-url missing before base; DSNs verified"
else not_ok "secrets.sh check [rc=$RC]" "$WORK/out"; fi
echo "0123456789abcdef" >"$s/values/postwave_staging_db-app-password"
run_script "$s" 1 "$SCRIPTS/secrets.sh" check
if [ "$RC" = 1 ] && out_has 'MISMATCH   db-dsn (does not match db-app-password)' && out_has 'ok         ops-db-dsn'; then
  ok "secrets.sh check flags a DSN whose password changed, and keeps checking"
else not_ok "secrets.sh check mismatch [rc=$RC]" "$WORK/out"; fi

# 4. teardown.sh, dry run, a deployed environment.
s=$(new_state teardown-dry)
deployed_fixture "$s"
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/teardown.sh"
if [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] && out_has 'moosewave-staging-services (us-west-2' &&
   out_has 'empty postwave-staging-uploads-111122223333' && out_has 'postwave-listmonk and all its images' &&
   out_has 'postwave/staging/api-key-pepper' && ! out_has 'REFUSING'; then
  ok "teardown.sh (DRY_RUN, deployed): full inventory, zero write calls"
else
  not_ok "teardown.sh (DRY_RUN, deployed) [rc=$RC writes=$(writes "$s")]" "$WORK/out"
fi

# 5-8. teardown.sh refuses, before any write, when any item lacks the tag.
refusal_case() { # <name> <mutation command> <expected text>
  local s
  s=$(new_state "teardown-$1")
  deployed_fixture "$s"
  (cd "$s" && eval "$2")
  run_script "$s" 1 env CONFIRM=moosewave-staging "$SCRIPTS/teardown.sh"
  if [ "$RC" = 1 ] && [ "$(writes "$s")" = 0 ] && out_has REFUSING && out_has "$3"; then
    ok "teardown.sh refuses with $1 (no write call)"
  else
    not_ok "teardown.sh refuses with $1 [rc=$RC writes=$(writes "$s")]" "$WORK/out"
  fi
}
refusal_case "an untagged ECR repository" ': >repos/postwave-api' "ECR repository postwave-api does not carry"
refusal_case "a bucket tagged for another project" 'echo other >buckets/postwave-staging-exports-111122223333' "bucket postwave-staging-exports-111122223333 does not carry"
refusal_case "an untagged stack" 'jq ".Stacks[0].Tags = []" stacks/moosewave-staging-ses.json >t && mv t stacks/moosewave-staging-ses.json' "stack moosewave-staging-ses (eu-west-1) does not carry"
refusal_case "a stack from another template" 'jq ".Stacks[0].Description = \"production stack\"" stacks/moosewave-staging-base.json >t && mv t stacks/moosewave-staging-base.json' "was not created from an infra/aws/staging template"
refusal_case "an untagged secret" "jq '.SecretList[1].Tags = []' secrets.json >t && mv t secrets.json" "secret postwave/staging/api-key-pepper does not carry"

# 9. teardown.sh cost-guard refuses while the environment exists.
s=$(new_state teardown-costguard)
deployed_fixture "$s"
run_script "$s" 1 env CONFIRM=moosewave-staging "$SCRIPTS/teardown.sh" cost-guard
if [ "$RC" = 1 ] && [ "$(writes "$s")" = 0 ] && out_has 'the cost guard outlives the environment'; then
  ok "teardown.sh cost-guard refuses while the environment exists"
else not_ok "teardown.sh cost-guard refuses while the environment exists [rc=$RC]" "$WORK/out"; fi

# 10-11. pause.sh.
s=$(new_state pause-dry)
deployed_fixture "$s"
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/pause.sh"
if [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] && out_has 'would scale postwave-api from 1 to 0' &&
   out_has 'would stop i-0123456789abcdef0' && out_has 'postwave-web: already 0'; then
  ok "pause.sh (DRY_RUN): scales down and stops the database on paper, zero write calls"
else not_ok "pause.sh (DRY_RUN) [rc=$RC writes=$(writes "$s")]" "$WORK/out"; fi
s=$(new_state pause-untagged)
deployed_fixture "$s"
echo someone-else >"$s/cluster_tag"
run_script "$s" 1 "$SCRIPTS/pause.sh"
if [ "$RC" = 1 ] && [ "$(writes "$s")" = 0 ] && out_has 'refusing: ECS cluster postwave-staging does not carry'; then
  ok "pause.sh refuses an untagged cluster before any write"
else not_ok "pause.sh refuses an untagged cluster [rc=$RC writes=$(writes "$s")]" "$WORK/out"; fi

# 12. resume.sh, dry run, paused.
s=$(new_state resume-dry)
deployed_fixture "$s"
jq '.State.Name = "stopped"' "$s/instance.json" >"$s/t" && mv "$s/t" "$s/instance.json"
jq '.services[].desiredCount = 0' "$s/services.json" >"$s/t" && mv "$s/t" "$s/services.json"
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/resume.sh"
if [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] && out_has 'would start i-0123456789abcdef0' &&
   out_has 'would scale postwave-clamav from 0 to 1' && out_has 'would scale postwave-api from 0 to 1' &&
   ! out_has 'would scale postwave-web'; then
  ok "resume.sh (DRY_RUN): starts only flagged services, zero write calls"
else not_ok "resume.sh (DRY_RUN) [rc=$RC writes=$(writes "$s")]" "$WORK/out"; fi

# 13-15. deploy.sh change-set handling (writes allowed; the fake answers them).
s=$(new_state changeset-nochange)
stack_fixture "$s" moosewave-staging-cost-global UPDATE_COMPLETE "$(outputs MonthlyBudgetName=moosewave-staging-monthly)"
echo '{"Status":"FAILED","StatusReason":"The submitted information didn'"'"'t contain changes. Submit different information to create a change set.","Changes":[]}' >"$s/changeset.json"
run_script "$s" 0 "$SCRIPTS/deploy.sh" cost-global
if [ "$RC" = 0 ] && grep -q '^WRITE cloudformation create-change-set .*--change-set-type UPDATE' "$s/calls.log" &&
   grep -q '^WRITE cloudformation delete-change-set' "$s/calls.log" &&
   ! grep -q 'execute-change-set' "$s/calls.log" && out_has 'no changes' && out_has 'MonthlyBudgetName = moosewave-staging-monthly'; then
  ok "deploy.sh: a change set without changes is deleted, not executed"
else not_ok "deploy.sh no-change change set [rc=$RC]" "$WORK/out"; fi

replacement_state() {
  local s
  s=$(new_state "changeset-$1")
  deployed_fixture "$s"
  secrets_fixture "$s" moosewave-staging db-postgres-password db-app-password db-ops-password redis-auth-token \
    listmonk-db-password listmonk-admin-password
  echo '{"Status":"CREATE_COMPLETE","Changes":[{"ResourceChange":{"Action":"Modify","LogicalResourceId":"DbInstance","ResourceType":"AWS::EC2::Instance","Replacement":"True"}},{"ResourceChange":{"Action":"Modify","LogicalResourceId":"ApiTaskRole","ResourceType":"AWS::IAM::Role","Replacement":"False"}}]}' >"$s/changeset.json"
  printf '%s\n' "$s"
}
s=$(replacement_state refused)
run_script "$s" 0 "$SCRIPTS/deploy.sh" base
if [ "$RC" = 1 ] && out_has 'refusing: this change would replace or remove stateful resources' &&
   out_has 'DbInstance (Modify, replacement=True)' && ! out_has 'ApiTaskRole (Modify' &&
   grep -q '^WRITE cloudformation delete-change-set' "$s/calls.log" &&
   ! grep -q 'execute-change-set' "$s/calls.log"; then
  ok "deploy.sh: replacing the database is refused and the change set deleted"
else not_ok "deploy.sh refuses a database replacement [rc=$RC]" "$WORK/out"; fi
s=$(replacement_state allowed)
run_script "$s" 0 env ALLOW_REPLACEMENT=1 "$SCRIPTS/deploy.sh" base
if [ "$RC" = 0 ] && grep -q '^WRITE cloudformation execute-change-set' "$s/calls.log"; then
  ok "deploy.sh: ALLOW_REPLACEMENT=1 executes the same change set"
else not_ok "deploy.sh with ALLOW_REPLACEMENT=1 [rc=$RC]" "$WORK/out"; fi

# 16. deploy.sh base keeps the database AMI and network on update.
s=$(new_state base-update)
deployed_fixture "$s"
secrets_fixture "$s" moosewave-staging db-postgres-password db-app-password db-ops-password redis-auth-token \
  listmonk-db-password listmonk-admin-password
run_script "$s" 1 env DRY_RUN=1 "$SCRIPTS/deploy.sh" base
if [ "$RC" = 0 ] && out_has 'DbImageId = (unchanged)' && out_has 'SubnetIdA = (unchanged)' &&
   out_has 'HostedZoneId = (unchanged)' && out_has 'SesRegion = (unchanged)' &&
   ! out_has 'SesConfigurationSetName' && ! grep -q 'ssm get-parameter' "$s/calls.log"; then
  ok "deploy.sh base (update): DbImageId, network, zone and every unset existing parameter keep their values"
else not_ok "deploy.sh base (update) keeps DbImageId [rc=$RC]" "$WORK/out"; fi

# 17. build-images.sh (DRY_RUN) warns when the API commit would still send
# three platform mails from @moosewave.com (no configuredPlatformSender).
build_repo() { # <1: apps/api has configuredPlatformSender | 0> -> a one-commit repo with these scripts
  local d="$WORK/buildrepo.$1"
  rm -rf "$d"
  mkdir -p "$d/infra/aws/staging" "$d/apps/api"
  cp -R "$SCRIPTS" "$d/infra/aws/staging/"
  if [ "$1" = 1 ]; then printf 'package main\n\nfunc configuredPlatformSender() string { return "" }\n' >"$d/apps/api/wiring_auth.go"
  else printf 'package main\n' >"$d/apps/api/wiring_auth.go"; fi
  git -C "$d" init -q && git -C "$d" add -A &&
    git -C "$d" -c user.name=test -c user.email=test@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null \
      commit -qm fixture || return 1
  printf '%s\n' "$d"
}
build_dry() { # <1|0> <IMAGES>
  local repo s
  repo=$(build_repo "$1")
  s=$(new_state "build-$1-$2")
  run_script "$s" 1 env DRY_RUN=1 IMAGES="$2" "$repo/infra/aws/staging/scripts/build-images.sh"
  [ "$RC" = 0 ] && [ "$(writes "$s")" = 0 ] && out_has 'would start moosewave-staging-images'
}
if build_dry 0 api-mjml,db-migrator && out_has 'passes no platform sender to the segment-decay, dashboard-digest and webhook-alert workers' &&
   build_dry 1 api-mjml,db-migrator && ! out_has 'platform sender' &&
   build_dry 0 clamav,listmonk && ! out_has 'platform sender'; then
  ok "build-images.sh (DRY_RUN): warns only for an API commit without configuredPlatformSender, zero write calls"
else not_ok "build-images.sh platform-sender warning [rc=$RC]" "$WORK/out"; fi

# ----------------------------------------------------------------- smoke
mkdir -p "$WORK/fakecurl"
cat >"$WORK/fakecurl/curl" <<'CURL'
#!/usr/bin/env bash
# Answers like a healthy staging ALB. FAKE_CURL_NOINDEX=0 drops X-Robots-Tag.
out="" hdr="" url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; -D) hdr=$2; shift 2 ;; -w|--max-time|--proto|-H) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
body="" code=200 headers="HTTP/1.1 200 OK"
case "$url" in
  http://*) code=301; headers="HTTP/1.1 301 Moved Permanently
Location: https://${url#http://}"; headers=$(printf '%s' "$headers" | sed 's|^Location: https://\([^/]*\)/|Location: https://\1:443/|') ;;
  */api/ready) body='{"status":"ready"}' ;;
  */healthz) body='{"status":"ok","service":"postwave-web"}' ;;
  */robots.txt) body=$(printf 'User-Agent: *\r\nDisallow: /\r\n') ;;
  */login) [ "${FAKE_CURL_NOINDEX:-1}" = 0 ] || headers="$headers
x-robots-tag: noindex, nofollow, noarchive" ;;
  https://archive.*) code=404 ;;
esac
[ -z "$out" ] || printf '%s' "$body" >"$out"
[ -z "$hdr" ] || printf '%s\r\n' "$headers" >"$hdr"
printf '%s' "$code"
CURL
chmod +x "$WORK/fakecurl/curl"
RC=0; PATH="$WORK/fakecurl:$PATH" "$SCRIPTS/smoke.sh" >"$WORK/out" 2>&1 || RC=$?
if [ "$RC" = 0 ] && [ "$(grep -c '^  ok' "$WORK/out")" = 17 ]; then ok "smoke.sh passes a healthy environment (17 checks, :443 redirect form accepted)"
else not_ok "smoke.sh healthy [rc=$RC]" "$WORK/out"; fi
RC=0; PATH="$WORK/fakecurl:$PATH" FAKE_CURL_NOINDEX=0 "$SCRIPTS/smoke.sh" web >"$WORK/out" 2>&1 || RC=$?
if [ "$RC" = 1 ] && out_has 'FAIL  app./login has no X-Robots-Tag' && out_has 'smoke: 1 check(s) failed'; then
  ok "smoke.sh fails a web that would be indexed"
else not_ok "smoke.sh without noindex [rc=$RC]" "$WORK/out"; fi

# ---------------------------------------------------------------- docker
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  check "clamav.Dockerfile builds (options read back as disabled)" \
    docker buildx build --platform linux/arm64 --provenance=false -q \
      -f "$STAGING/clamav.Dockerfile" -t moosewave-staging-test/clamav:run "$STAGING"

  # The ScratchVolumes init on each image's own base (the FROM of the API's
  # ordinary-service stage and of the web runtime stage) plus that image's
  # uid 10001 user, against Fargate's starting point: an empty volume owned by
  # root, 0755 (a no-copy volume here, checked first). Before the init uid
  # 10001 cannot write; after it each directory is 10001's, has its mode, and
  # takes a write from uid 10001 on a read-only root.
  scratch_script() { # services.yaml Mappings ScratchVolumes Init Script, unindented
    awk '/^      Script: \|$/ { p = 1; next } p && /^        / { sub(/^        /, ""); print; next } p { exit }' "$STAGING/services.yaml"
  }
  SCRATCH_MOUNTS=()
  scratch_run() { # <user> <image> <command>
    docker run --rm --read-only "${SCRATCH_MOUNTS[@]}" --user "$1" --entrypoint /bin/sh "$2" -c "$3"
  }
  scratch_body() { # <image> <SCRATCH_DIRS>
    local img="$1" dirs="$2" spec d m out
    for spec in $dirs; do
      d=${spec%:*}
      [ "$(scratch_run 0 "$img" "stat -c '%u %a' '$d'")" = "0 755" ] ||
        { echo "$d: a fresh no-copy volume is not root 0755 here, so this test proves nothing"; return 1; }
      if scratch_run 10001:10001 "$img" ": >'$d/probe'" 2>/dev/null; then echo "$d: uid 10001 could write before the init"; return 1; fi
    done
    out=$(docker run --rm --read-only "${SCRATCH_MOUNTS[@]}" --user 0 -e "SCRATCH_DIRS=$dirs" \
      --entrypoint /bin/sh "$img" -c "$(scratch_script)" 2>&1) || { echo "the init failed: $out"; return 1; }
    for spec in $dirs; do
      d=${spec%:*}; m=${spec##*:}; m=${m#0}
      printf '%s\n' "$out" | grep -qxF "scratch volume $d: 10001:10001 $m, writable by uid 10001" ||
        { echo "the init did not report $d as 10001:10001 $m: $out"; return 1; }
      scratch_run 10001:10001 "$img" ": >'$d/probe' && rm '$d/probe'" || { echo "$d: uid 10001 cannot write after the init"; return 1; }
    done
  }
  scratch_on_base() { # <base image> <SCRATCH_DIRS>
    local img=moosewave-staging-test/scratch:run spec n=0 rc=0
    [ -n "$1" ] && [ -n "$2" ] && [ -n "$(scratch_script)" ] || { echo "no base image, SCRATCH_DIRS or init script"; return 1; }
    printf 'FROM %s\nRUN addgroup -S -g 10001 postwave && adduser -S -u 10001 -G postwave -h /home/postwave -s /sbin/nologin postwave\nUSER 10001:10001\n' "$1" |
      docker build -q -t "$img" - >/dev/null || return 1
    SCRATCH_MOUNTS=()
    for spec in $2; do
      n=$((n + 1))
      docker volume create "moosewave-staging-scratch-$$-$n" >/dev/null || return 1
      SCRATCH_MOUNTS+=(--mount "type=volume,src=moosewave-staging-scratch-$$-$n,dst=${spec%:*},volume-nocopy=true")
    done
    scratch_body "$img" "$2" || rc=1
    while [ "$n" -gt 0 ]; do docker volume rm -f "moosewave-staging-scratch-$$-$n" >/dev/null 2>&1 || true; n=$((n - 1)); done
    docker rmi "$img" >/dev/null 2>&1 || true
    return "$rc"
  }
  check "scratch volumes: the init makes Fargate-style root 0755 volumes writable by uid 10001 (API base image)" \
    scratch_on_base "$(awk '$1 == "FROM" && $NF == "ordinary-service" { print $2 }' "$REPO/Dockerfile.go")" \
      "$(kv "$(scratch_report ApiTaskDefinition)" dirs)"
  check "scratch volumes: the init makes Fargate-style root 0755 volumes writable by uid 10001 (web base image)" \
    scratch_on_base "$(awk '$1 == "FROM" && $NF == "runtime" { print $2 }' "$REPO/apps/web/Dockerfile")" \
      "$(kv "$(scratch_report WebTaskDefinition)" dirs)"

  PG_CONTAINER="moosewave-staging-sqltest-$$"
  docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=unused-test-password \
    postgres:16-alpine >/dev/null
  pg() { docker exec -i "$PG_CONTAINER" "$@"; }
  for _ in $(seq 60); do pg pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
  sleep 2
  pg sh -c 'apk add --no-cache bash sudo >/dev/null && cat >/usr/local/bin/aws <<"AWS"
#!/bin/sh
# test stand-in for the host'"'"'s AWS CLI: prints the secret the step asks for
case "$*" in
  *postwave/staging/db-ops-password*) printf "%s\n" "0123456789abcdef0123456789abcdef" ;;
  *postwave/staging/listmonk-admin-password*) printf "%s\n" "fedcba9876543210fedcba9876543210" ;;
  *) exit 1 ;;
esac
AWS
chmod +x /usr/local/bin/aws'
  host() { "$SCRIPTS/db-post-migrate.sh" print-host-script "$1" | pg bash >"$WORK/host.out" 2>&1; }
  sqlq() { pg psql -X -tA -U postgres "$@"; }

  sqlq -c 'CREATE DATABASE postwave' >/dev/null
  if ! host ops-login && grep -q 'role postwave_ops does not exist: run migrate.sh first' "$WORK/host.out"; then
    ok "ops-login fails clearly before migration 1700 created postwave_ops"
  else not_ok "ops-login before the role exists" "$WORK/host.out"; fi
  sqlq -d postwave -c 'CREATE ROLE postwave_ops NOLOGIN' >/dev/null
  if host ops-login && host ops-login && grep -q 'postwave_ops: login=t superuser=f bypassrls=f' "$WORK/host.out" &&
     pg env PGPASSWORD=0123456789abcdef0123456789abcdef psql -X -tA -h 127.0.0.1 -U postwave_ops -d postwave \
       -c 'select current_user' 2>&1 | grep -qx postwave_ops; then
    ok "ops-login lets postwave_ops log in with the secret's password (twice: idempotent)"
  else not_ok "ops-login" "$WORK/host.out"; fi

  sqlq -c 'CREATE DATABASE listmonk' >/dev/null
  if ! host listmonk-api-user && grep -q 'listmonk has not installed its schema yet' "$WORK/host.out"; then
    ok "listmonk-api-user fails clearly before listmonk installed its schema"
  else not_ok "listmonk-api-user before the schema" "$WORK/host.out"; fi
  # The tables the step touches, shaped like listmonk's, with its install
  # defaults: an enabled SMTP server on a third-party host, plus a postback.
  sqlq -d listmonk -c "CREATE TABLE roles (id serial PRIMARY KEY, type text, name text);
    CREATE TABLE users (id serial PRIMARY KEY, username text UNIQUE, password_login boolean, password text,
      email text, name text, type text, user_role_id int REFERENCES roles(id), status text);
    CREATE TABLE settings (key text NOT NULL UNIQUE, value jsonb NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT now());
    INSERT INTO roles (type, name) VALUES ('list', 'x'), ('user', 'Super Admin');
    INSERT INTO settings (key, value) VALUES
      ('smtp', '[{\"enabled\": true, \"host\": \"smtp.yoursite.com\", \"port\": 25}, {\"enabled\": false, \"host\": \"smtp.gmail.com\", \"port\": 465}]'),
      ('messengers', '[{\"enabled\": true, \"name\": \"relay\", \"root_url\": \"https://relay.example\"}]');" >/dev/null
  if host listmonk-api-user && host listmonk-api-user &&
     [ "$(sqlq -d listmonk -c "SELECT count(*) || ':' || max(password) || ':' || max(type) || ':' || max(status) FROM users WHERE username = 'api'")" = \
       "1:fedcba9876543210fedcba9876543210:api:enabled" ]; then
    ok "listmonk-api-user creates exactly one enabled api user with the token (twice: idempotent)"
  else not_ok "listmonk-api-user" "$WORK/host.out"; fi
  if [ "$(sqlq -d listmonk -c "SELECT jsonb_array_length(value) || ':' || (value->0->>'enabled') || ':' || (value->0->>'host')
           || ':' || (value->0->>'port') FROM settings WHERE key = 'smtp'")" = "1:true:127.0.0.1:25" ] &&
     [ "$(sqlq -d listmonk -c "SELECT value FROM settings WHERE key = 'messengers'")" = "[]" ] &&
     grep -q 'listmonk smtp: 127.0.0.1:25 enabled=true' "$WORK/host.out"; then
    ok "listmonk-api-user replaces listmonk's SMTP with one loopback server and drops every postback"
  else not_ok "listmonk-api-user SMTP settings" "$WORK/host.out"; fi

  # The real listmonk v6.1.0 staging runs (same digest and command), on a
  # docker network with no route out: after the step it must load the
  # loopback SMTP, accept a /api/tx send from the api user, stay up, and log
  # the refused delivery. (With every server disabled instead, this version
  # panics on the send.)
  LM_IMAGE=listmonk/listmonk:v6.1.0@sha256:179d00d9553c371b6fe88c9b145095d651e275bdd66db46b2e0b79daff316b6f
  lm_command=$(sed -n 's/^ *- \(\.\/listmonk --install .*\)$/\1/p' "$STAGING/services.yaml")
  LM_NET="moosewave-staging-lmtest-$$"
  docker network create --internal "$LM_NET" >/dev/null
  docker network connect "$LM_NET" "$PG_CONTAINER"
  LM_CONTAINER="moosewave-staging-lmtest-$$"
  lm_start() {
    docker rm -f "$LM_CONTAINER" >/dev/null 2>&1 || true
    docker run -d --name "$LM_CONTAINER" --network "$LM_NET" \
      -e LISTMONK_app__address=0.0.0.0:9000 -e LISTMONK_db__host="$PG_CONTAINER" -e LISTMONK_db__port=5432 \
      -e LISTMONK_db__user=listmonk_user -e LISTMONK_db__password=lm-test-password -e LISTMONK_db__database=listmonk \
      -e LISTMONK_db__ssl_mode=disable -e LISTMONK_ADMIN_USER=admin -e LISTMONK_ADMIN_PASSWORD=lm-test-admin-password \
      "$LM_IMAGE" sh -c "$lm_command" >/dev/null || return 1
    for _ in $(seq 90); do
      docker exec "$LM_CONTAINER" wget -qO- http://127.0.0.1:9000/health >/dev/null 2>&1 && return 0
      sleep 1
    done
    echo "listmonk did not become healthy"; docker logs "$LM_CONTAINER" 2>&1 | tail -n 20; return 1
  }
  lm_refused() { docker logs "$LM_CONTAINER" 2>&1 | grep -q 'error sending message.*127\.0\.0\.1:25.*connection refused'; }
  real_listmonk_ok() {
    local response
    [ -n "$lm_command" ] || { echo "no listmonk command in services.yaml"; return 1; }
    sqlq -c 'DROP DATABASE listmonk' -c "CREATE ROLE listmonk_user LOGIN PASSWORD 'lm-test-password'" \
      -c 'CREATE DATABASE listmonk OWNER listmonk_user' >/dev/null || return 1
    lm_start || return 1
    [ "$(sqlq -d listmonk -c "SELECT value->0->>'host' FROM settings WHERE key = 'smtp'")" != 127.0.0.1 ] ||
      { echo "a fresh install already uses loopback SMTP: this test proves nothing"; return 1; }
    host listmonk-api-user || { cat "$WORK/host.out"; return 1; }
    lm_start || return 1
    docker logs "$LM_CONTAINER" 2>&1 | grep -q 'initialized email (SMTP) messenger: @127\.0\.0\.1$' ||
      { echo "listmonk did not load the loopback SMTP"; docker logs "$LM_CONTAINER" 2>&1 | tail -n 20; return 1; }
    response=$(docker exec "$LM_CONTAINER" wget -qO- --header 'Authorization: token api:fedcba9876543210fedcba9876543210' \
      --header 'Content-Type: application/json' \
      --post-data '{"subscriber_mode":"external","subscriber_emails":["someone@example.com"],"template_id":3,"data":{}}' \
      http://127.0.0.1:9000/api/tx 2>&1) || { echo "the api user's send failed: $response"; return 1; }
    [ "$response" = '{"data":true}' ] || { echo "/api/tx answered: $response"; return 1; }
    for _ in $(seq 20); do lm_refused && break; sleep 1; done
    lm_refused || { echo "no refused delivery in the log"; docker logs "$LM_CONTAINER" 2>&1 | tail -n 20; return 1; }
    [ "$(docker inspect -f '{{.State.Running}}' "$LM_CONTAINER")" = true ] || { echo "listmonk stopped after the send"; return 1; }
  }
  check "real listmonk v6.1.0: after listmonk-api-user a send is accepted, refused on loopback, and listmonk stays up" real_listmonk_ok
  if ! "$SCRIPTS/db-post-migrate.sh" print-host-script ops-login | grep -Eq '[0-9a-f]{32}'; then
    ok "the host scripts carry no secret value"
  else not_ok "a host script contains something secret-shaped"; fi
else
  echo "skip  docker tests (docker not available)"
fi

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
