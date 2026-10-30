# Desktop file-transfer and external-intent contract

Status: implemented in source and focused tests on 2026-07-16. Signed installed-package qualification remains required on macOS and Windows before `VERIFIED`.

## Why this boundary exists

Before DUX-029, production renderer code contained 21 independent anchor/object-URL downloads, eight raw file inputs, three FileReader implementations, several authenticated exports opened in a browser, and 17 direct `_blank` links. Those paths disagreed on cancellation, filename validation, URL lifetime, errors, auth, privacy, progress, and whether a successful click meant a file was actually saved.

The implementation now has three explicit boundaries:

- `src/lib/file-transfer.ts` owns picker, validation, remote download, browser save fallback, native chunk streaming, progress, cancellation, retry hooks, upload tracking, and privacy-safe filenames.
- `src/lib/file-transfer-history.ts` owns the bounded seven-day transfer journal, lifecycle warning/cancel integration, and transient retry/cancel/reveal actions. It never stores a filesystem path, URL, query token, or personal/confidential filename. Persistence uses an opaque user/workspace scope, never adopts the unscoped v1 journal, hides immediately when identity is unresolved, purges foreign scopes without reading them, and is erased at full sign-out or a completed workspace switch.
- `src/components/ExternalLink.tsx` owns renderer external-link activation and routes it through the same allowlisted Tauri opener as programmatic intents.

The lazy `TransferCenter` in the top bar gives users one place to inspect imports, downloads, saves, uploads, failures, retries, cancellations, collisions, and native “Show in folder” actions.

## Native trust boundary

The desktop uses the official Tauri dialog and filesystem plugins, but does not grant general filesystem access:

- capability grants: `dialog:allow-open`, `dialog:allow-save`, `fs:allow-read-file`, and `fs:allow-stat`;
- explicitly absent: renderer write, create, rename, remove, directory-read, and global path scopes;
- the dialog plugin dynamically adds only the path the operator selected;
- import read/stat occurs against that exact runtime scope, then `transfer_revoke_picker_path` removes the grant;
- export bytes cross IPC in chunks no larger than 256 KiB; Rust rejects chunks over 512 KiB, out-of-order offsets, size overflow, incomplete finish, excessive concurrent sessions, and files over 2 GiB;
- Rust verifies the request came from the bundled main window and that the save path is picker-granted;
- writes use a private, create-new sibling partial file, `sync_all`, same-directory atomic replacement, and directory sync/write-through;
- cancel/error/stale-session cleanup removes the partial file and revokes both the original picker path and its normalized equivalent;
- reveal accepts only a cryptographically random, opaque, bounded, one-hour completed-transfer id. The renderer cannot supply or infer a reveal path;
- existing symlink/non-regular targets and unnormalized/relative paths fail closed.

The browser fallback uses one hidden anchor implementation, defers object-URL revocation for one second, and reports only “download started” because a web renderer cannot prove where the browser saved the file.

## Transfer semantics

### Imports and uploads

Every production picker now enters through `pickImportFiles` or `pickFileMetadata`. Policies define extension allowlists, per-file/aggregate byte caps, maximum file count, empty-file behavior, label, and privacy class. Native metadata-only picking does not copy bytes into renderer memory. Drag/drop goes through the same validation contract.

Uploads can publish determinate byte progress through `beginUploadTransfer`; the resumable migration upload feeds acknowledged server bytes into it. Asset, subscriber, suppression, and translation imports publish their honest phase boundaries and retain retry where the underlying operation can be replayed.

### Downloads and exports

`downloadUrlToFile` accepts HTTPS (plus loopback HTTP in development), rejects credentials-in-URL and overlong/unsafe schemes, uses no referrer and no ambient credentials, enforces advertised and observed byte limits, reads Content-Disposition safely, publishes progress, and then hands the response to the same native/browser save path. CORS-only failures may delegate to the guarded OS browser opener; the journal labels this “Opened in browser” instead of claiming a native save.

`saveFile` normalizes reserved/control/path-like names, preserves a bounded extension, supports an AbortSignal and progress callback, records collision replacement, and returns a discriminated saved/download-started/cancelled/failed result. Callers no longer toast success before this result.

### Privacy and history

History is capped at 40 records and seven days. On restart, an in-progress record becomes a structural `interrupted` failure. Public filenames and labels may be retained; personal and confidential entries retain only a generic operation label plus a generic file class and bounded extension. Persisted records are schema-, string-, timestamp-, byte- and enum-bounded before rendering. Errors are structural codes, not exception strings. Remote URLs, signed query tokens, local paths, file contents, campaign/workspace/subscriber identifiers, and other private labels are never persisted.

Active transfers register with the shared lifecycle coordinator. Sign-out, workspace switch, quit, close, update restart, and OS shutdown therefore disclose unfinished transfers and can cancel supported operations instead of silently abandoning them.

## Migrated surface inventory

### Blob/generated saves

- SMS conversations, subscribers (server and page fallback), selected campaigns, DMARC reports, privacy-incident packets, AIVS proof bundles, translation dictionaries, report-builder CSV, chart CSV/PNG, audit NLQ filters, tap-to-text QR images, DSAR ZIPs, segment growth, subscriber data/consent receipts, selected-subscriber export, agent configuration, and audience-sync exclusion receipts.

### Authenticated or signed remote downloads

- MCP execution history, synchronous and prepared audit exports, suppressions, product events, discount redemptions, form submissions, workspace data bundles, campaign recipient reports, and subscriber note attachments.

### Pickers/imports/uploads

- collections CSV/JSON, asset-library multi-upload and drag/drop, migration CSV and drag/drop, translation dictionary CSV, asset-picker upload, subscriber CSV, suppression CSV, and note-attachment metadata selection.

### External intents

- every former production `_blank` anchor now renders through `ExternalLink` (audit/provider docs, public/archive URLs, MITRE links, review widgets, media/receipt/incident links, referral share channels, blocklist delisting, and contextual help);
- programmatic OAuth, hosted-form, archive, legal, support, asset-preview, and provider intents already route through `tauriApi.openUrl`;
- allowlisted schemes are HTTPS, development loopback HTTP, Moosewave mail, recipient-less share mail, and bounded SMS share intents. JavaScript, file, credential-bearing URLs, arbitrary HTTP, arbitrary mail recipients, and unexpected SMS query keys fail closed.

## Evidence and regression gates

- `src/__tests__/lib/file-transfer.test.ts`: validation, privacy redaction, browser save, bounded native chunking, picker read/stat, metadata-only pick, no-referrer remote progress/save.
- `src/__tests__/components/external-link.test.tsx`: guarded safe activation and unsafe-scheme denial.
- `src/__tests__/file-transfer-source-contract.test.ts`: zero direct production download/file-input/FileReader/`_blank` primitives and least-privilege capability/Rust invariants.
- Rust unit tests cover normalized absolute paths, non-identifying private sibling partials, cryptographically random reveal IDs, stale-session partial cleanup/scope handoff, and atomic replacement.
- Existing caller tests were migrated to assert the typed transfer boundary instead of anchor clicks or `openUrl`.

## Installed-package qualification still required

Source completion is not installed-runtime proof. Before changing DUX-029 to `VERIFIED`, qualify signed current builds on both supported OS families:

1. macOS save/open panels, replacement prompt, APFS and non-APFS volumes, denied/protected folders, FileVault volume, cancel at picker/download/write, crash/power-loss partial behavior, Finder reveal, VoiceOver, keyboard-only operation, and app relaunch history.
2. Windows save/open panels, NTFS replacement/write-through, long/non-ASCII paths, Controlled Folder Access/antivirus denial, OneDrive/network/removable destinations, cancel at every phase, Explorer reveal, Narrator, keyboard-only operation, and app relaunch history.
3. Both: 0 B, exact chunk boundary, multi-chunk, near-cap and over-cap files; collision/race; offline/proxy/TLS/CORS; token expiry; retry; concurrent transfers; quit/sign-out/workspace/update lifecycle; external default-app absence; and proof that no path/token/private filename enters logs, diagnostics, telemetry, or persisted history.
