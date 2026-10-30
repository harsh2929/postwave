#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "usage: $0 <vsix-path> <expected-version> <owner/repository>" >&2
  exit 64
}

fail() {
  echo "VSIX verification failed: $*" >&2
  exit 1
}

[[ $# -eq 3 ]] || usage

vsix_path=$1
expected_version=$2
expected_repository=$3

[[ -f "$vsix_path" ]] || fail "archive does not exist: $vsix_path"
[[ "$expected_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "version must be stable major.minor.patch"
[[ "$expected_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || fail "repository must be owner/name"
[[ "$(basename "$vsix_path")" == "postwave-vscode-${expected_version}.vsix" ]] \
  || fail "archive filename must be postwave-vscode-${expected_version}.vsix"

for command_name in unzip zipinfo jq grep find sort uniq awk du wc node; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command is unavailable: $command_name"
done

archive_bytes=$(wc -c < "$vsix_path" | tr -d '[:space:]')
[[ "$archive_bytes" =~ ^[0-9]+$ ]] || fail "could not determine archive size"
(( archive_bytes > 0 && archive_bytes <= 10 * 1024 * 1024 )) \
  || fail "archive is empty or larger than 10 MiB (${archive_bytes} bytes)"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/postwave-vsix.XXXXXX")
entries_file="$work_dir/entries.txt"
extract_dir="$work_dir/extracted"
trap 'rm -rf "$work_dir"' EXIT

unzip -tqq "$vsix_path" >/dev/null || fail "ZIP integrity check failed"
unzip -Z1 "$vsix_path" > "$entries_file"
[[ -s "$entries_file" ]] || fail "archive has no entries"

entry_count=$(wc -l < "$entries_file" | tr -d '[:space:]')
(( entry_count == 11 )) || fail "archive must contain exactly 11 allowlisted entries (found ${entry_count})"

uncompressed_bytes=$(LC_ALL=C zipinfo -t "$vsix_path" | awk '{print $3}')
[[ "$uncompressed_bytes" =~ ^[0-9]+$ ]] || fail "could not determine uncompressed size"
(( uncompressed_bytes <= 25 * 1024 * 1024 )) \
  || fail "archive expands beyond 25 MiB (${uncompressed_bytes} bytes)"

duplicates=$(LC_ALL=C sort "$entries_file" | uniq -d)
[[ -z "$duplicates" ]] || fail "archive contains duplicate paths: $duplicates"
case_insensitive_duplicates=$(tr '[:upper:]' '[:lower:]' < "$entries_file" | LC_ALL=C sort | uniq -d)
[[ -z "$case_insensitive_duplicates" ]] \
  || fail "archive contains case-insensitive duplicate paths: $case_insensitive_duplicates"

if LC_ALL=C grep -n '[[:cntrl:]]' "$entries_file" >/dev/null; then
  fail "archive path contains a control character"
fi

while IFS= read -r entry; do
  [[ -n "$entry" ]] || fail "archive contains an empty path"
  [[ "$entry" != /* ]] || fail "archive contains an absolute path: $entry"
  [[ ! "$entry" =~ ^[A-Za-z]:[\\/] ]] || fail "archive contains a drive path: $entry"
  [[ "$entry" != *\\* ]] || fail "archive path uses a backslash: $entry"
  [[ ! "$entry" =~ (^|/)\.\.(/|$) ]] || fail "archive contains path traversal: $entry"
  case "$entry" in
    "[Content_Types].xml"|extension.vsixmanifest|extension|extension/|extension/*)
      ;;
    *)
      fail "unexpected top-level archive path: $entry"
      ;;
  esac

  lower_entry=$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')
  case "$lower_entry" in
    *.map|*/node_modules/*|*/.git/*|*/.github/*|*/.turbo/*|*/tests/*|*/test/*|*.test.ts|*.test.js|*.spec.ts|*.spec.js|*.ts|*.tsx|*.pem|*.key|*.p12|*.pfx|*/.env|*/.env.*|*/id_rsa|*/id_ed25519)
      fail "forbidden file entered the VSIX: $entry"
      ;;
  esac
done < "$entries_file"

mkdir -p "$extract_dir"
unzip -qq "$vsix_path" -d "$extract_dir"

if find "$extract_dir" -type l -print -quit | grep -q .; then
  fail "archive contains a symbolic link"
fi

unpacked_kib=$(du -sk "$extract_dir" | awk '{print $1}')
[[ "$unpacked_kib" =~ ^[0-9]+$ ]] || fail "could not determine unpacked size"
(( unpacked_kib <= 25 * 1024 )) \
  || fail "unpacked archive is larger than 25 MiB (${unpacked_kib} KiB)"

required_paths=(
  "[Content_Types].xml"
  "extension.vsixmanifest"
  "extension/package.json"
  "extension/out/extension.js"
  "extension/media/postwave.png"
  "extension/media/postwave.svg"
  "extension/src/snippets/postwave-snippets.code-snippets"
  "extension/language-configuration.json"
  "extension/readme.md"
  "extension/changelog.md"
  "extension/LICENSE.txt"
)
for required_path in "${required_paths[@]}"; do
  [[ -f "$extract_dir/$required_path" ]] || fail "required file is missing: $required_path"
done

expected_repository_url="git+https://github.com/${expected_repository}.git"
expected_bugs_url="https://github.com/${expected_repository}/issues"
package_json="$extract_dir/extension/package.json"
jq -e \
  --arg version "$expected_version" \
  --arg repository_url "$expected_repository_url" \
  --arg bugs_url "$expected_bugs_url" '
    .name == "postwave-vscode" and
    .publisher == "postwave" and
    .version == $version and
    .main == "./out/extension.js" and
    .icon == "media/postwave.png" and
    .license == "MIT" and
    .engines.vscode == "^1.85.0" and
    (.private // false) == false and
    (.dependencies // {} | length) == 0 and
    .repository.type == "git" and
    .repository.url == $repository_url and
    .repository.directory == "packages/vscode-extension" and
    .bugs.url == $bugs_url and
    .publishConfig.access == "public" and
    ((.files | sort) == ([
      "CHANGELOG.md",
      "LICENSE",
      "README.md",
      "language-configuration.json",
      "media/postwave.png",
      "media/postwave.svg",
      "out/extension.js",
      "src/snippets/postwave-snippets.code-snippets"
    ] | sort)) and
    (([.contributes.commands[].command] | sort) == ([
      "postwave.devServer.start",
      "postwave.email.sendTest",
      "postwave.login",
      "postwave.logout",
      "postwave.preview.open"
    ] | sort)) and
    (.contributes.configuration.properties | has("postwave.apiKey") | not) and
    .contributes.configuration.properties["postwave.devServerUrl"].default == "http://localhost:4321" and
    (.contributes.viewsContainers.activitybar |
      any(.id == "postwave" and .icon == "./media/postwave.svg"))
  ' "$package_json" >/dev/null \
  || fail "packaged extension metadata does not match the release contract"

manifest="$extract_dir/extension.vsixmanifest"
grep -Eq '<Identity[^>]*Id="postwave-vscode"' "$manifest" \
  || fail "VSIX manifest has the wrong extension id"
grep -Eq '<Identity[^>]*Publisher="postwave"' "$manifest" \
  || fail "VSIX manifest has the wrong publisher"
grep -Eq "<Identity[^>]*Version=\"${expected_version//./\\.}\"" "$manifest" \
  || fail "VSIX manifest has the wrong version"

extension_js="$extract_dir/extension/out/extension.js"
extension_bytes=$(wc -c < "$extension_js" | tr -d '[:space:]')
(( extension_bytes >= 1024 )) || fail "compiled extension entrypoint is unexpectedly small"
if grep -Eq 'sourceMappingURL=.*\.map([[:space:]]|$)' "$extension_js"; then
  fail "compiled extension points to a source map that must not ship"
fi

jq empty "$extract_dir/extension/language-configuration.json" \
  "$extract_dir/extension/src/snippets/postwave-snippets.code-snippets" \
  || fail "packaged JSON asset is invalid"
icon_svg="$extract_dir/extension/media/postwave.svg"
grep -Eq '<svg([[:space:]>])' "$icon_svg" || fail "activity icon is not SVG"
if grep -Eiq '<script|<foreignObject|href[[:space:]]*=|url[[:space:]]*\(' "$icon_svg"; then
  fail "activity icon contains active or external content"
fi
node - "$extract_dir/extension/media/postwave.png" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const image = fs.readFileSync(path);
const signature = "89504e470d0a1a0a";
if (
  image.length < 24 ||
  image.subarray(0, 8).toString("hex") !== signature ||
  image.readUInt32BE(16) !== 128 ||
  image.readUInt32BE(20) !== 128
) {
  console.error("VSIX verification failed: Marketplace icon must be a 128x128 PNG");
  process.exit(1);
}
NODE

if LC_ALL=C grep -RIE -n \
  --exclude='*.png' \
  --exclude='*.svg' \
  -- '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk_live_[A-Za-z0-9]{16,}' \
  "$extract_dir/extension" >/dev/null; then
  fail "archive content matches a high-confidence credential pattern"
fi

echo "Verified postwave.postwave-vscode ${expected_version}: ${entry_count} entries, ${archive_bytes} compressed bytes"
