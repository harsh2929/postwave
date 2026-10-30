# Desktop supported platforms

Status: release contract  
Owner: Desktop / Release Engineering  
Last reviewed: 2026-07-14

Moosewave Desktop supports the following production floor:

| Platform | Minimum         | Runtime requirement                                                      | Architectures                                       |
| -------- | --------------- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| macOS    | 11.0 Big Sur    | Safari/WebKit 16.2 or newer; install all available Safari and OS updates | Apple Silicon and Intel                             |
| Windows  | Windows 10 22H2 | Microsoft Edge WebView2 Runtime 111 or newer                             | x64; arm64 only when an arm64 artifact is published |

Windows 11 is supported under the same WebView2 contract. Linux packages are
development artifacts and are not a supported client distribution channel.

The Rust dependency gate encodes the current release triples exactly:
`aarch64-apple-darwin`, `x86_64-apple-darwin`, and
`x86_64-pc-windows-msvc`. Adding Windows arm64 or another supported triple
requires extending the executable reachability proof in the same change.
Linux cannot become a release target while the expiring GTK3/netlink RustSec
exceptions in `apps/desktop/src-tauri/audit-exceptions.json` remain.

The renderer bootstrap targets `safari14` and `chrome109`; `esnext` is
prohibited so an outdated runtime can still parse and render the compatibility
screen. Before credential hydration, the application requires CSS color mixing,
container queries, native `inert`, and secure Web Crypto. Those capabilities
set the usable runtime floor at WebKit 16.2 and WebView2 111. An older runtime
fails closed with update instructions instead of rendering a partially styled
or accessibility-broken application. The macOS deployment floor remains encoded
as `minimumSystemVersion: 11.0` in Tauri configuration.

The feature floor is source-backed: WebKit records `color-mix()` as shipping in
[Safari 16.2](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/),
and Chromium records it as shipping in
[Chrome 111](https://developer.chrome.com/docs/css-ui/css-color-mix). This
matters because the current renderer uses that function throughout semantic
state and design-system styling; merely transpiling JavaScript for an older
parser would not make an older CSS engine a supported application runtime.

## Release qualification

Every release candidate must retain evidence for both minimum-runtime machines:

1. clean install and first launch;
2. login and operating-system credential-vault access;
3. dashboard navigation and a representative create/edit mutation;
4. offline launch, queued mutation, reconnect and replay;
5. deep link, tray, notification and second-instance handling;
6. signed update, rollback to the last supported build, and uninstall;
7. keyboard navigation, 200% zoom and screen-reader smoke;
8. startup time, idle memory and crash-free 30-minute soak.

An `esnext` build, a test performed only on the newest hosted runner, or an
installer that silently downloads an unpinned WebView2 runtime does not satisfy
this contract. Results belong in the immutable release evidence bundle.
