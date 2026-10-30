// SPDX-License-Identifier: AGPL-3.0-only

export function isMockModeEnabled(): boolean {
  const configured =
    process.env.NEXT_PUBLIC_USE_MOCKS === "1" &&
    process.env.NODE_ENV !== "production";
  if (!configured) return false;

  // Browser integration tests often run against the same long-lived dev
  // server humans use for the demo workspace. Requiring that server to be
  // restarted without NEXT_PUBLIC_USE_MOCKS would make route-intercepted
  // failure/retry tests both disruptive and nondeterministic. A flag installed
  // before application JavaScript loads lets those tests use their intercepted
  // API responses while leaving the shared server's normal mock experience
  // untouched. Production is already returned above, so this test hook can
  // never turn a production build's API mode on or off.
  if (typeof window !== "undefined") {
    const runtime = window as typeof window & {
      __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
    };
    if (runtime.__POSTWAVE_FORCE_REAL_API_FOR_E2E__ === true) return false;
  }

  return true;
}
