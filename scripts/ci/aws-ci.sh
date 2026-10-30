#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# Run the repository's CI for one commit on AWS CodeBuild and post the results
# to GitHub as commit statuses. For when GitHub-hosted runners are unavailable
# (an Actions spending limit). It needs no GitHub admin rights: the source is
# exported from the local clone and uploaded to S3, and statuses are posted
# with the caller's `gh` token (push access is enough).
#
#   scripts/ci/aws-ci.sh [<sha>|HEAD|--staged] [--groups contracts,web,packages,go,ops,mobile] [--continue] [--no-status] [--no-wait]
#   scripts/ci/aws-ci.sh [<sha>|HEAD|--staged] --export-only <dir>
#   scripts/ci/aws-ci.sh --log <build-id>
#   scripts/ci/aws-ci.sh --summarize <saved build log>
#
# --staged runs the INDEX (git write-tree) instead of a commit: the way to
# prove a change before committing it on a shared branch. --continue keeps
# every step of a group running after a failure so one run reports them all.
# --export-only writes the source zip a build would receive to <dir>/<id>.zip,
# checks it against the tree and stops: no AWS or GitHub call is made.
# --log prints one build's complete CloudWatch log, oldest line first.
# --summarize prints the failure summary a failed run prints, for a log saved
# by --log or kept under $TMPDIR/postwave-ci-logs.
# Default groups: contracts web packages go ops mobile (e2e is opt-in).
# Each group is one CodeBuild build of project postwave-ci running
# infra/aws/codebuild/ci-group.sh; that file documents which workflow jobs
# each group mirrors. Logs: CloudWatch /aws/codebuild/postwave-ci.
set -euo pipefail

REGION="${POSTWAVE_CI_REGION:-us-east-1}"
PROJECT="${POSTWAVE_CI_PROJECT:-postwave-ci}"
REPO_SLUG="${POSTWAVE_CI_REPO:-harsh2929/postwave}"
DEFAULT_GROUPS="contracts web packages go ops mobile"
# Compute per group: web/go/mobile/packages need the 15 GB class for
# next build, -race tests, the Expo export and the package builds.
compute_for() {
  case "$1" in
    web|go|mobile|packages|e2e) echo BUILD_GENERAL1_LARGE ;;
    *) echo BUILD_GENERAL1_MEDIUM ;;
  esac
}
# The source bucket is named after the caller's account; no account id is
# written down here (the sensitive-handoff contract forbids retired ones).
# Resolved only when uploading, so --export-only and --log make no STS call.
BUCKET=""
resolve_bucket() {
  if [[ -n "${POSTWAVE_CI_BUCKET:-}" ]]; then BUCKET="$POSTWAVE_CI_BUCKET"; return 0; fi
  local account
  account="$(aws sts get-caller-identity --query Account --output text)"
  BUCKET="docai-codebuild-source-$account"
}

# --- failure summary ---------------------------------------------------------
# What failed, from one build's complete log, in log order. Always printed:
# ci-group.sh's `--- FAIL <step>` and summary lines, CodeBuild's phase error,
# and every Go package failure, which is go test's `FAIL<TAB><package>` line
# (failed tests, a timeout, a panic, fatal error or signal, an exit from
# TestMain or a test, `[build failed]`, `[setup failed]`), with each
# `panic:`, `fatal error:`, `SIGxxx:` and `signal:` line and a timeout's list
# of running tests; a package that dies that way prints no `--- FAIL:` line.
# Then the detail lines, go test's top-level `--- FAIL:` lines and Go compile
# and vet errors: only the last 12 are printed, and a line says how many
# earlier ones were left out.
failure_summary() { # <log file>
  awk -v keep=12 '
    function add(kind) { n++; text[n] = $0; kinds[n] = kind; if (kind == "detail") details++ }
    running && /^\t/ { add("headline"); next }
    { running = 0 }
    /^--- FAIL / || /^=== \[[^]]*\] summary:/ || /Phase context status code: [A-Z]/ { add("headline"); next }
    /^FAIL\t/ { add("headline"); next }
    /^(panic|fatal error|signal): / || /^SIG[A-Z]+: / { add("headline"); running = /^panic: test timed out/; next }
    /^--- FAIL: / || /^[^[:space:]#:][^:]*\.go:[0-9]+:[0-9]+: / { add("detail") }
    END {
      omit = details - keep
      for (i = 1; i <= n; i++) {
        if (kinds[i] == "detail" && skipped < omit) {
          if (skipped++ == 0) printf "... %d earlier failing-test and compile-error lines left out (see the log)\n", omit
          continue
        }
        print text[i]
      }
    }' "$1"
}

ref="HEAD"; groups="$DEFAULT_GROUPS"; post_status=1; wait_for=1; staged=0; ci_continue=""
export_dir=""; log_build=""; summary_log=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --groups) groups="${2//,/ }"; shift 2 ;;
    --staged) staged=1; shift ;;
    --continue) ci_continue=1; shift ;;
    --no-status) post_status=0; shift ;;
    --no-wait) wait_for=0; shift ;;
    --export-only) export_dir="${2:?--export-only needs a directory}"; shift 2 ;;
    --log) log_build="${2:?--log needs a build id (postwave-ci:<uuid>)}"; shift 2 ;;
    --summarize) summary_log="${2:?--summarize needs a saved build log}"; shift 2 ;;
    -h|--help) awk 'NR == 1 { next } /^set -euo pipefail/ { exit } { print }' "$0"; exit 0 ;;
    *) ref="$1"; shift ;;
  esac
done
# A saved log needs no repository, AWS or GitHub.
if [[ -n "$summary_log" ]]; then failure_summary "$summary_log"; exit 0; fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
work="$(mktemp -d "${TMPDIR:-/tmp}/postwave-ci.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# --- source export -----------------------------------------------------------
# A build must start from what actions/checkout gives a workflow job: every
# tracked file of the commit, and nothing else. `git archive` is not that. It
# honours .gitattributes export-ignore, which strips /proprietary on purpose
# so PUBLIC source exports carry only the redistributable stubs
# (LICENSE-BOUNDARY.md). Every CodeBuild tree therefore lacked the private
# prompt packs a checkout has, and the diagnostician prompt tests read the
# 439-byte stub prompts and failed there only. This zip is not a public
# export: it goes to the account's private source bucket and is read only by
# this project's builds, the audience a runner's checkout has. So the export
# reads the tree into a throwaway index and checks every entry out, the way a
# checkout does, then zips that directory.
#
# The bytes must depend on the tree alone. Run in this clone, checkout-index
# reads a directory's .gitattributes from the working tree before the tree's
# own copy, so a modified or untracked one (CRLF, $Id$ expansion, a filter)
# changes what is exported; .git/info/attributes, the caller's global and
# system attributes and config, and GIT_* variables such as GIT_ATTR_SOURCE
# apply too. So every git command of the export runs in a repository of its
# own under $work, with an empty environment and HOME. It reads this clone's
# objects through objects/info/alternates (nothing is copied, and nothing is
# written to this clone), it has no attributes, config, hooks or templates of
# its own, and it checks out with an empty directory as its work tree, so the
# only attributes it sees are the tree's own .gitattributes, read from its
# index.
export_repo="$work/export.git"
export_git() { # <work tree> <index file> <git args...>
  local tree="$1" index="$2"; shift 2
  # The pins give the Linux runner's checkout on any platform: no CRLF
  # conversion, real symlinks, and exec bits read back from the files.
  env -i PATH="$PATH" HOME="$work/home" GIT_CONFIG_NOSYSTEM=1 GIT_ATTR_NOSYSTEM=1 \
    GIT_DIR="$export_repo" GIT_WORK_TREE="$tree" GIT_INDEX_FILE="$index" \
    git -c core.autocrlf=false -c core.eol=lf -c core.symlinks=true -c core.filemode=true "$@"
}
init_export_repo() {
  [[ -d "$export_repo" ]] && return 0
  local objects format args=(-q --bare --template=)
  objects="$(cd "$(git rev-parse --git-common-dir)/objects" && pwd -P)"
  format="$(git rev-parse --show-object-format 2>/dev/null || echo sha1)"
  [[ "$format" == sha1 ]] || args+=(--object-format="$format")
  mkdir -p "$work/home" "$work/empty"
  env -i PATH="$PATH" HOME="$work/home" GIT_CONFIG_NOSYSTEM=1 git init "${args[@]}" "$export_repo"
  mkdir -p "$export_repo/objects/info"
  printf '%s\n' "$objects" > "$export_repo/objects/info/alternates"
}
export_source() { # <tree-ish> <zip path>
  # The zip is built and verified under $work and moved to <zip path> only
  # once it has passed, so a failed export leaves nothing to upload or reuse.
  local treeish="$1" zip_out="$2" zip_tmp="$work/export.zip" tree_dir="$work/tree" index="$work/export.index"
  init_export_repo
  rm -rf "$tree_dir" "$index" "$zip_tmp" "$zip_out"
  mkdir -p "$tree_dir"
  # The index file must not exist yet: git refuses a zero-byte index file.
  export_git "$work/empty" "$index" read-tree "$treeish"
  # umask 022 gives the modes a checkout gives (0644, and 0755 for
  # executables).
  ( umask 022
    export_git "$work/empty" "$index" checkout-index --all --force --prefix="$tree_dir/" )
  # zip entries carry local time with no zone; the build container reads them
  # as UTC, so write them in UTC or every source file looks hours newer than
  # anything the build produces (the published-dist freshness test caught
  # this). -X leaves out the extra fields (uid/gid and a second timestamp), so
  # that UTC time is the only one; -y stores symlinks as links.
  ( cd "$tree_dir" && TZ=UTC zip -q -r -y -X "$zip_tmp" . )
  verify_export "$treeish" "$zip_tmp"
  mv "$zip_tmp" "$zip_out"
}

# The zip must hold exactly the tree's files, byte for byte and mode for mode.
# It is unpacked and snapshotted the way buildspec-ci.yml does on the build
# host (`git add -A -f .` into a new index), in the export repository, and
# that index must list the same mode, blob and path for every entry as the
# tree. A missing path is the export-ignore gap coming back, an extra one is
# local state, and a changed blob or mode is a conversion or a lost exec bit.
verify_export() { # <tree-ish> <zip path>
  local treeish="$1" zip_in="$2" unpacked="$work/unpacked"
  rm -rf "$unpacked" "$work/verify.index"
  mkdir -p "$unpacked"
  unzip -q -o "$zip_in" -d "$unpacked"
  ( cd "$unpacked" && export_git "$unpacked" "$work/verify.index" add -A -f . )
  # Gitlinks (submodules) check out as empty directories, as they do with the
  # workflows' `submodules: false`, so the zip has no entry for them. Both
  # listings are in index order.
  export_git "$work/empty" "$work/export.index" ls-files -s -z | tr '\0' '\n' | awk '$1 != "160000"' > "$work/tree.entries"
  export_git "$unpacked" "$work/verify.index" ls-files -s -z | tr '\0' '\n' > "$work/zip.entries"
  if ! cmp -s "$work/tree.entries" "$work/zip.entries"; then
    # Into a file first: `head` on a pipe would end the pipeline with SIGPIPE.
    { diff "$work/tree.entries" "$work/zip.entries" || true; } | { grep '^[<>]' || true; } > "$work/export.diff"
    echo "source export does not match tree $treeish: $(wc -l < "$work/export.diff" | tr -d ' ') lines differ (< mode, blob and path in the tree; > in the zip); the first 20:" >&2
    head -20 "$work/export.diff" >&2
    return 1
  fi
}

file_size() { wc -c < "$1" | tr -d ' '; }

# --- CloudWatch logs ---------------------------------------------------------
# One `aws logs get-log-events` call returns ONE page: at most 1 MB or 10,000
# events, and without --start-from-head the page at the END of the stream. Its
# text output also joins a page's messages with tabs, so a grep for line
# starts (this script's failure summary did that) matched nothing, and a log
# read while the build is still writing stops mid-run. fetch_build_log walks
# the stream from the head until nextForwardToken comes back unchanged (the
# API's end-of-stream signal) and writes every event as one line, in stream
# order. save_build_log re-reads until CodeBuild's last line has arrived.
LOG_END_MARKER='Phase complete: UPLOAD_ARTIFACTS'
# Both are called from `if` and `||`, where bash suspends `set -e`, so every
# command checks its own status.
fetch_build_log() { # <build id>: the complete log, oldest line first, on stdout
  local stream="${1#*:}" token="" next pages=0
  while :; do
    rm -f "$work/log-page.json" "$work/log-token"
    # shellcheck disable=SC2086 # ${token:+...} expands to nothing or two words.
    aws logs get-log-events --region "$REGION" --log-group-name "/aws/codebuild/$PROJECT" \
      --log-stream-name "$stream" --start-from-head ${token:+--next-token "$token"} \
      --output json > "$work/log-page.json" || return 1
    python3 - "$work/log-page.json" "$work/log-token" <<'PY' || return 1
import json, sys
page = json.load(open(sys.argv[1], encoding="utf-8"))
with open(sys.argv[2], "w", encoding="utf-8") as token:
    token.write(page.get("nextForwardToken") or "")
for event in page.get("events", []):
    message = event["message"]
    sys.stdout.buffer.write((message if message.endswith("\n") else message + "\n").encode("utf-8", "replace"))
PY
    next="$(cat "$work/log-token")" || return 1
    [[ -z "$next" || "$next" == "$token" ]] && return 0
    token="$next"
    pages=$((pages + 1))
    if [[ $pages -ge 10000 ]]; then echo "the log of $1 did not end after $pages pages" >&2; return 1; fi
  done
}
save_build_log() { # <build id> <file>
  local attempt
  for attempt in 1 2 3 4 5 6; do
    fetch_build_log "$1" > "$2" || return 1
    if grep -q "$LOG_END_MARKER" "$2"; then return 0; fi
    if [[ $attempt -lt 6 ]]; then sleep 10; fi
  done
  echo "WARN: the log of $1 has no '$LOG_END_MARKER' line after 6 reads; it may be incomplete" >&2
}

if [[ -n "$log_build" ]]; then
  save_build_log "$log_build" "$work/build.log"
  cat "$work/build.log"
  exit 0
fi

if [[ $staged -eq 1 ]]; then
  sha="$(git write-tree)"          # a tree id; statuses are skipped below
  subject="staged index (tree $sha)"
  post_status=0
else
  sha="$(git rev-parse --verify "${ref}^{commit}")"
  subject="$(git log -1 --format=%s "$sha")"
fi
short="${sha:0:9}"
echo "CI for $short — $subject"

# --- export the commit and upload it -----------------------------------------
# The zip is the bare tree; buildspec-ci.yml turns it into a single-commit
# repository on the build host so git-aware gates work, which keeps the
# upload at half the size of shipping a .git alongside the files.
if [[ -n "$export_dir" ]]; then
  mkdir -p "$export_dir"
  zip_path="$(cd "$export_dir" && pwd)/$sha.zip"
else
  zip_path="$work/$sha.zip"
fi
export_source "$sha" "$zip_path"
echo "source: $(du -h "$zip_path" | cut -f1), $(wc -l < "$work/zip.entries" | tr -d ' ') files, matches the tree byte for byte"
if [[ -n "$export_dir" ]]; then echo "exported $zip_path (--export-only: nothing uploaded)"; exit 0; fi

resolve_bucket
key="postwave-ci/source/$sha.zip"
echo "upload → s3://$BUCKET/$key"
# Verify the object after the copy: a multipart upload has returned success
# here while leaving no object behind, and a build that then fails at
# DOWNLOAD_SOURCE reads like a CI failure.
# Few concurrent parts: on a slow uplink the CLI default of 40 starves every
# connection until S3 closes it ("RequestTimeout ... UploadPart"). A private
# config file keeps the caller's ~/.aws/config untouched; credentials still
# come from the usual credential sources.
aws_cfg="$work/aws-config"
{
  printf '[default]\ns3 =\n  max_concurrent_requests = 3\n  multipart_chunksize = 16MB\n  multipart_threshold = 64MB\n'
  [[ -n "${AWS_PROFILE:-}" ]] && printf '[profile %s]\ns3 =\n  max_concurrent_requests = 3\n  multipart_chunksize = 16MB\n  multipart_threshold = 64MB\n' "$AWS_PROFILE"
} > "$aws_cfg"
# Upload through S3's dual-stack endpoint. It resolves to IPv6 where the host
# has it and to IPv4 otherwise, so it never removes a route. On 2026-09-13 the
# IPv4 route from the development machine to S3 dropped full-size packets
# (path MTU under 1500, and S3 does not clamp its segment size the way a CDN
# does): every part upload stalled until the connection was reset, the CLI
# then crashed in its own error handler and exited 0, and the check below
# caught it. The same upload over IPv6 took seconds. POSTWAVE_CI_S3_ENDPOINT
# selects "dualstack" (default), "regional", or an explicit https URL.
case "${POSTWAVE_CI_S3_ENDPOINT:-dualstack}" in
  dualstack) s3_endpoint="https://s3.dualstack.$REGION.amazonaws.com" ;;
  regional) s3_endpoint="https://s3.$REGION.amazonaws.com" ;;
  https://*) s3_endpoint="$POSTWAVE_CI_S3_ENDPOINT" ;;
  *) echo "POSTWAVE_CI_S3_ENDPOINT must be dualstack, regional or an https URL" >&2; exit 2 ;;
esac
uploaded=0
for attempt in 1 2 3; do
  AWS_CONFIG_FILE="$aws_cfg" aws s3 cp --only-show-errors --region "$REGION" --endpoint-url "$s3_endpoint" "$zip_path" "s3://$BUCKET/$key" || true
  size="$(aws s3api head-object --region "$REGION" --endpoint-url "$s3_endpoint" --bucket "$BUCKET" --key "$key" --query ContentLength --output text 2>/dev/null || echo 0)"
  if [[ "$size" == "$(file_size "$zip_path")" ]]; then uploaded=1; break; fi
  echo "upload attempt $attempt did not leave a complete object (size=$size); retrying"
done
[[ $uploaded -eq 1 ]] || { echo "upload failed three times" >&2; exit 3; }
echo "uploaded ($size bytes)"

# --- history gates, run here because they need the real git history -----------
# The migration lint reads pinned baselines with `git show <commit>:<path>`,
# and gitleaks in CI scans the commits of the push or PR (not the whole tree).
# Neither works on the single-commit snapshot CodeBuild receives, so both run
# on this clone, over the range against origin/main, and count in the result.
history_result="SKIPPED"
run_history_gates() {
  [[ $staged -eq 1 ]] && { echo "history gates: skipped for a staged tree (no commit range)"; return 0; }
  local base; base="$(git merge-base origin/main "$sha" 2>/dev/null || true)"
  local ok=1
  echo "history gates (local, range ${base:0:9}..$short):"
  if POSTWAVE_MIGRATION_LINT_BASE="$base" bash scripts/lint-migrations.test.sh >"$work/lint-migrations.log" 2>&1 \
     && POSTWAVE_MIGRATION_LINT_BASE="$base" bash scripts/lint-migrations.sh >>"$work/lint-migrations.log" 2>&1; then
    echo "  PASS migration lock, RLS, and tenant-FK lint"
  else
    ok=0; echo "  FAIL migration lock, RLS, and tenant-FK lint"; tail -12 "$work/lint-migrations.log" | sed 's/^/    /'
  fi
  if [[ -n "${POSTWAVE_CI_SCHEMA_DATABASE_URL:-}" ]]; then
    if DATABASE_URL="$POSTWAVE_CI_SCHEMA_DATABASE_URL" python3 scripts/lint-migrations-schema.py >"$work/schema-lint.log" 2>&1; then
      echo "  PASS reviewed migration-lint effective schema (against POSTWAVE_CI_SCHEMA_DATABASE_URL)"
    else
      ok=0; echo "  FAIL reviewed migration-lint effective schema"; tail -6 "$work/schema-lint.log" | sed 's/^/    /'
    fi
  else
    echo "  SKIPPED reviewed migration-lint effective schema (set POSTWAVE_CI_SCHEMA_DATABASE_URL to a database migrated to head)"
  fi
  if command -v gitleaks >/dev/null; then
    if gitleaks git . --config .gitleaks.toml --redact --exit-code 2 --no-banner --log-opts="${base}..${sha}" >"$work/gitleaks.log" 2>&1; then
      echo "  PASS gitleaks (commits ${base:0:9}..$short)"
    else
      ok=0; echo "  FAIL gitleaks (commits ${base:0:9}..$short)"; grep -E 'File:|RuleID:|Line:|leaks found' "$work/gitleaks.log" | paste - - - | sort | uniq -c | sort -rn | head -20 | sed 's/^/    /'
    fi
  else
    ok=0; echo "  FAIL gitleaks: not installed here (brew install gitleaks)"
  fi
  if [[ $ok -eq 1 ]]; then history_result="SUCCEEDED"; else history_result="FAILED"; fi
}

# --- GitHub statuses (optional) -----------------------------------------------
gh_token=""
if [[ $post_status -eq 1 ]] && command -v gh >/dev/null; then gh_token="$(gh auth token 2>/dev/null || true)"; fi
status() { # state context description target_url
  [[ -n "$gh_token" ]] || return 0
  curl -sS -o /dev/null -X POST -H "Authorization: token $gh_token" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO_SLUG/statuses/$sha" \
    -d "$(printf '{"state":"%s","context":"aws-codebuild/%s","description":"%s","target_url":"%s"}' "$1" "$2" "${3:0:130}" "$4")" \
    || echo "WARN: could not post status $2=$1"
}
console_url() { echo "https://$REGION.console.aws.amazon.com/codesuite/codebuild/projects/$PROJECT/build/$1/?region=$REGION"; }

run_history_gates
status "$( [[ $history_result == SUCCEEDED ]] && echo success || echo failure )" history-gates "migration lint + gitleaks over the commit range, run locally: $history_result" "https://github.com/$REPO_SLUG/commit/$sha"

# --- start one build per group ----------------------------------------------
# No --source-version: for an S3 source CodeBuild reads it as an object version
# id, and the commit is already the zip's name.
# Indexed arrays only: macOS ships bash 3.2, which has no associative arrays.
group_list=(); build_ids=(); results=()
for g in $groups; do
  # Retry while the project's concurrent-build limit is in use by an earlier run.
  id=""
  for attempt in $(seq 1 30); do
    id="$(aws codebuild start-build --region "$REGION" --project-name "$PROJECT" \
      --source-location-override "$BUCKET/postwave-ci/source/$sha.zip" \
      --compute-type-override "$(compute_for "$g")" \
      --environment-variables-override "name=CI_GROUP,value=$g,type=PLAINTEXT" "name=CI_SHA,value=$sha,type=PLAINTEXT" "name=CI_CONTINUE,value=$ci_continue,type=PLAINTEXT" \
      --query 'build.id' --output text 2>"$work/start-$g.err")" && break
    id=""
    if grep -q AccountLimitExceededException "$work/start-$g.err"; then echo "  $g: concurrent-build limit reached, retrying in 30 s ($attempt/30)"; sleep 30; else cat "$work/start-$g.err" >&2; exit 4; fi
  done
  [[ -n "$id" ]] || { echo "could not start $g" >&2; exit 4; }
  group_list+=("$g"); build_ids+=("$id"); results+=("")
  printf '  started %-10s %s\n' "$g" "$id"
  status pending "$g" "CodeBuild $g started for $short" "$(console_url "$id")"
done
[[ $wait_for -eq 1 ]] || { echo "not waiting (--no-wait)"; exit 0; }

# --- wait and report ---------------------------------------------------------
echo "waiting…"
while :; do
  pending=0
  for i in "${!group_list[@]}"; do
    g="${group_list[$i]}"; id="${build_ids[$i]}"
    [[ -n "${results[$i]}" ]] && continue
    st="$(aws codebuild batch-get-builds --region "$REGION" --ids "$id" --query 'builds[0].buildStatus' --output text)"
    if [[ "$st" == "IN_PROGRESS" ]]; then pending=1; continue; fi
    results[i]="$st"
    # shellcheck disable=SC2016 # backticks are JMESPath literals
    dur="$(aws codebuild batch-get-builds --region "$REGION" --ids "$id" --query 'builds[0].phases[?phaseType==`BUILD`].durationInSeconds|[0]' --output text)"
    printf '  %-10s %-10s build %ss\n' "$g" "$st" "$dur"
    if [[ "$st" == "SUCCEEDED" ]]; then status success "$g" "CodeBuild $g passed (${dur}s)" "$(console_url "$id")"
    else status failure "$g" "CodeBuild $g $st (${dur}s) — see CloudWatch /aws/codebuild/$PROJECT" "$(console_url "$id")"; fi
  done
  [[ $pending -eq 0 ]] && break
  sleep 30
done

echo
failed=0
printf '%-10s %s\n' "history" "$history_result"
[[ "$history_result" == "FAILED" ]] && failed=1
for i in "${!group_list[@]}"; do
  printf '%-10s %s\n' "${group_list[$i]}" "${results[$i]}"
  [[ "${results[$i]}" == "SUCCEEDED" ]] || failed=1
done
if [[ $failed -eq 1 ]]; then
  # The complete logs are kept (not in $work) so a failure is analysed from
  # the whole log, not re-fetched a page at a time.
  logs_dir="${TMPDIR:-/tmp}/postwave-ci-logs/$short"
  mkdir -p "$logs_dir"
  echo
  echo "Failed step(s) — from each failed build's complete log (kept in $logs_dir):"
  for i in "${!group_list[@]}"; do
    [[ "${results[$i]}" == "SUCCEEDED" ]] && continue
    g="${group_list[$i]}"; log="$logs_dir/$g.log"
    # shellcheck disable=SC2016 # backticks are JMESPath literals
    phase="$(aws codebuild batch-get-builds --region "$REGION" --ids "${build_ids[$i]}" \
      --query 'builds[0].phases[?phaseStatus && phaseStatus!=`SUCCEEDED`].phaseType|[0]' --output text 2>/dev/null || echo unknown)"
    if ! save_build_log "${build_ids[$i]}" "$log" 2>"$work/log-$g.err"; then
      echo "  [$g] failed in phase $phase; its log could not be read: $(tail -1 "$work/log-$g.err")"
      continue
    fi
    cat "$work/log-$g.err" >&2
    echo "  [$g] failed in phase $phase; $(wc -l < "$log" | tr -d ' ') lines in $log"
    if ! failure_summary "$log" | sed "s/^/  [$g] /"; then
      echo "  [$g] could not summarize $log; read it whole"
    fi
  done
fi
exit $failed
