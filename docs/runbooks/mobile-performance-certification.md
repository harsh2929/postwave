# Mobile physical-device performance certification

Use this runbook for every store candidate. The source and export-budget gates are necessary build checks; they are **not** evidence that an installed app starts, stays responsive, or behaves correctly under memory and network pressure.

## Release evidence

Create an evidence folder for the candidate and record all of the following before testing:

- Git commit and whether the workspace was clean.
- EAS build ID, profile, channel, app version, iOS build number or Android version code, and artifact SHA-256.
- API environment and any Expo update ID/runtime version applied to the binary.
- Device model, RAM, OS version, free storage, battery health/level, and thermal state.
- Test date, operator, network profile, and links to raw Instruments, Perfetto, log, screenshot, and screen-recording artifacts.

Do not reuse evidence from a different binary, update, backend environment, or release commit.

## Required device matrix

Test the release-mode installed artifact without Metro, a debugger, or developer-menu profiling enabled:

1. The oldest physical iPhone and iOS version the release supports.
2. A current representative iPhone.
3. A low-end physical Android device on the minimum supported Android version, with no more than 4 GiB RAM.
4. A current representative Android device.

At least one device on each platform must start from a clean install. Repeat authentication, deep-link, notification, offline-cache, and account-switch checks after force-stopping the app.

## Physical-device HTTPS setup

Development-client testing must use organization-approved HTTPS origins as described in [`apps/mobile/README.md`](../../apps/mobile/README.md#physical-device-development). Both `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_URL` must be origins without a path.

Before installing the candidate:

1. Open both HTTPS origins on the device and verify the certificate chain is trusted and matches the hostname.
2. Confirm API CORS/origin policy admits the configured app origin without using a wildcard with credentials.
3. Ensure neither URL contains credentials, access tokens, tunnel control parameters, or a developer's private hostname.
4. Uninstall the previous app, remove any test-only root certificate that is not part of the approved setup, reinstall, and capture the resolved public configuration from the build record.

A laptop LAN address over plain HTTP is not a supported physical-device configuration. Android USB loopback via `adb reverse` is an emulator/development convenience, not production-device evidence.

## Performance budgets

Run each timing scenario 20 times after one unrecorded warm-up. Report P50, P95, and maximum; a single run is not acceptable evidence.

| Metric                                                         | Release budget                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cold launch to usable authenticated or signed-out shell        | P95 at most 3.0 s on low-end Android and 2.5 s on the oldest supported iPhone; no run over 5.0 s              |
| Warm foreground resume to interactive                          | P95 at most 1.0 s; no stale sensitive screen exposed while session state resolves                             |
| Screen transition or primary action feedback                   | P95 at most 500 ms; immediate visual feedback begins within 100 ms                                            |
| Rendering during a standard scripted journey                   | At least 99% of frames within the platform frame deadline; no frozen frame of 700 ms or longer                |
| Steady memory after the 10-minute journey                      | At most 250 MiB Android total PSS and 250 MiB iOS physical footprint                                          |
| Peak memory during image, QR, report, and large-list scenarios | At most 350 MiB; returns to within 15% of the steady baseline within two minutes                              |
| Background/foreground cycle                                    | 20 cycles without crash, forced logout, duplicate mutation, navigation reset, or monotonically growing memory |
| Slow-network first usable page                                 | At most 5.0 s on the defined slow-4G profile, with a visible loading/retry state and no request storm         |

If a platform tool cannot report a metric exactly as named, record the nearest native metric and the conversion or interpretation used. A budget change requires a reviewed change to this document and comparison evidence from the previous release; do not relax a threshold only in the release notes.

## Measurement procedure

### Android

Use a release APK/AAB-derived install and capture logcat plus a Perfetto or Android Studio system trace.

- Cold start: force-stop the package, then record `adb shell am start -W -n com.moosewave.app/.MainActivity`. Use `TotalTime` for the launch sample and corroborate the first/fully-drawn frame in the trace.
- Memory: capture `adb shell dumpsys meminfo com.moosewave.app` after launch, after the scripted journey, at the peak scenario, and two minutes after returning idle. Record total PSS and native/Java/graphics breakdowns.
- Rendering: record frame timing/jank through Perfetto or Android Studio while executing the same scripted journey on every candidate.
- Network: capture request count, transfer bytes, retries, response status, and timing with Android Studio Network Inspector or an approved test proxy. Redact tokens and personal data before retaining evidence.

### iOS

Use the release configuration on a physical device and retain the Instruments trace.

- Cold start and resume: use the App Launch template and OS signposts. Terminate the app between cold samples.
- Memory: use Allocations/Leaks and the Memory gauge to capture physical footprint at the same checkpoints as Android. Treat any leak-cycle growth or memory-pressure termination as a failure even when the numeric cap is met.
- Rendering and interactions: use Core Animation/Animation Hitches and Time Profiler during the scripted journey.
- Network: use the Network instrument or an approved test proxy and retain a redacted request summary.

## Scripted journeys

Run the same deterministic seed account on all devices:

1. Clean launch, sign in, background for 30 seconds, and resume.
2. Open dashboard, subscribers, campaigns, analytics, notifications, settings, and one deep link.
3. Scroll at least 200 rows in a tenant with at least 10,000 subscribers and 1,000 campaigns; open five details and return.
4. Exercise an image/QR/report-heavy view and a mutation with success, validation failure, and server failure.
5. Repeat the journey on slow 4G, offline at launch, offline during a mutation, and a connection that changes online/offline five times in 60 seconds.
6. Background/foreground the app 20 times, then repeat the memory checkpoint and one primary mutation.

The network trace must show bounded pagination, no duplicate concurrent request for the same query key, no unbounded retry loop, and no secret or personal data in URLs. Offline and flapping-network tests must preserve queued work without duplicate submission and must give an actionable recovery state.

## Pass/fail record

Certification passes only when every required device and scenario has raw evidence, every numeric budget passes, there are no crashes/ANRs/watchdog terminations/leaks, and all deviations have a resolved owner. Record missing hardware, credentials, signing access, or backend fixtures as **not run** and keep the release blocked; do not report those cases as passing or not applicable.
