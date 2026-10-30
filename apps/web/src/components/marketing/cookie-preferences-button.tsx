// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { COOKIE_PREFERENCES_EVENT } from "./cookie-banner";

export function CookiePreferencesButton(): JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex min-h-11 items-center text-left transition-colors hover:text-pw-ink2 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 md:min-h-0"
      onClick={() => {
        window.dispatchEvent(new Event(COOKIE_PREFERENCES_EVENT));
      }}
    >
      Cookie preferences
    </button>
  );
}
