/**
 * lib/preferenceCenterTheme.ts — the pure half of the hosted preference-centre
 * theme editor.
 *
 * WHAT THIS THEMES. Four columns on `tenant_preference_customization` drive the
 * chrome of the page real subscribers land on from an unsubscribe link
 * (apps/api/internal/preferences renders it from
 * `PublicPreferenceCustomization`: logo_url, primary_color, footer_text,
 * show_postwave_badge — and nothing else). Desktop has had an editor for it
 * since PrivacyPortal.tsx:118; mobile had no caller for the route at all, so
 * the one surface a subscriber sees could not be corrected from a phone.
 *
 * WIRE SHAPE, read off apps/api/internal/privacy_portal/preference_center.go:
 *   GET   /api/v1/privacy/portal/preference-center  → PreferenceCustomization
 *   PATCH /api/v1/privacy/portal/preference-center  → the same object back
 *   PUT   … is the same handler (`UpsertPreferenceCustomization`), so PATCH is
 *   a FULL REPLACE: "the frontend always sends the full theme object so we
 *   treat PATCH as a full replace (same as PUT)". Every field goes on every
 *   save; an omitted one is a cleared column, not an untouched one.
 *
 *   { "tenantId": "…", "logo_url": "…", "primary_color": "#5B6CFF",
 *     "footer_text": "…", "show_postwave_badge": true }
 *
 *   `tenantId` is RESPONSE-ONLY. Echoing it back earns
 *   422 validation_failed "tenantId is response-only" (preference_center.go:275),
 *   so `preferenceThemePayload` never emits it.
 *
 * BOUNDS ARE THE SERVER'S. Every refusal below is transcribed from the Go
 * validator, sentence for sentence, because those exact strings are what a 422
 * carries back (`httperror.WriteValidation(w, "validation_failed", err.Error())`).
 * Pre-checking locally only saves a round trip; it never invents a rule the
 * server would not have applied. The one rule that is OURS — the white-on-
 * primary contrast floor — is a separate, NON-BLOCKING advisory
 * (`preferenceThemeContrastAdvisory`) precisely so it cannot be mistaken for an
 * API bound.
 *
 * Import-free (no react-native / expo) so it runs under node vitest.
 */

import { utf8ByteLength } from "./inboundTriggerValidation";
import {
  LOGO_URL_MAX_BYTES,
  preferenceLogoUrlAccepted,
} from "./preferenceCenterLogoUrl";

export interface PreferenceCenterTheme {
  logoUrl: string;
  primaryColor: string;
  footerText: string;
  showPostwaveBadge: boolean;
}

/**
 * `defaultPreferenceCustomization()` in preference_center.go:92 — what the GET
 * answers for a tenant that has never saved a row. Kept identical so "Use
 * defaults" here writes the same theme the server would have served.
 */
export const PREFERENCE_THEME_DEFAULTS: PreferenceCenterTheme = {
  logoUrl: "",
  primaryColor: "#5B6CFF",
  footerText: "You're receiving this because you subscribed.",
  showPostwaveBadge: true,
};

/** The numbers the Go validator enforces, named so the UI can quote them. */
export const PREFERENCE_THEME_LIMITS = {
  /** `logoURLMaxBytes` — measured in BYTES, like Go's len(string). */
  logoUrlMaxBytes: LOGO_URL_MAX_BYTES,
  /** `footerMaxBytes`. */
  footerMaxBytes: 4096,
  /** OUR readability floor, not a server bound. See PreferenceThemeAdvisory. */
  minContrastRatio: 4.5,
} as const;

/* ── The server's own sentences ─────────────────────────────────────────── */

/** preference_center.go:58 (ErrInvalidLogoURL). */
export const SERVER_LOGO_REFUSAL =
  "logo_url must be empty or an https URL without credentials";
/** preference_center.go:55 (ErrInvalidPrimaryColor). */
export const SERVER_COLOR_REFUSAL =
  "primary_color must match /^#[0-9A-Fa-f]{6}$/";
/** preference_center.go:56 (ErrFooterTooLong). */
export const SERVER_FOOTER_LONG_REFUSAL =
  "footer_text must be at most 4096 bytes";
/** preference_center.go:57 (ErrInvalidFooterText). */
export const SERVER_FOOTER_CONTROL_REFUSAL =
  "footer_text contains unsupported control or formatting characters";

export interface PreferenceThemeIssue {
  field: "logoUrl" | "primaryColor" | "footerText";
  /** The 422's own sentence, rendered verbatim. */
  message: string;
}

/**
 * A readability warning, NOT a refusal.
 *
 * The hosted page paints white button text on `primary_color`, so a pale colour
 * ships an unreadable button. Desktop's editor blocks a save below 4.5:1
 * (PreferenceCenterCustomization.tsx `validateTheme`) - but the API accepts any
 * six-digit hex, and the API's OWN DEFAULT, #5B6CFF, measures 4.17:1. Blocking
 * on it here would leave every tenant that has never edited their theme unable
 * to save a footer or a logo without also changing their brand colour. So this
 * warns, in its own words, and says who would refuse it.
 */
export interface PreferenceThemeAdvisory {
  field: "primaryColor";
  ratio: number;
  message: string;
}

/* ── Parsing ────────────────────────────────────────────────────────────── */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The GET/PATCH body → a theme. A field of the wrong type falls back to the
 * package default rather than rendering `undefined` into a subscriber-facing
 * preview; `show_postwave_badge` in particular must never read as OFF because
 * the field was missing — the server's zero-row default is ON.
 */
export function parsePreferenceCenterTheme(
  payload: unknown,
): PreferenceCenterTheme {
  const raw = (payload ?? {}) as Record<string, unknown>;
  return {
    logoUrl: str(raw.logo_url),
    primaryColor:
      typeof raw.primary_color === "string" && raw.primary_color.trim() !== ""
        ? raw.primary_color
        : PREFERENCE_THEME_DEFAULTS.primaryColor,
    footerText: str(raw.footer_text),
    showPostwaveBadge:
      typeof raw.show_postwave_badge === "boolean"
        ? raw.show_postwave_badge
        : PREFERENCE_THEME_DEFAULTS.showPostwaveBadge,
  };
}

/**
 * The PATCH body. Full replace, `tenantId` omitted, and the two fields the Go
 * validator trims (`logo_url`, `primary_color`) trimmed here so what we send is
 * what it will store. `footer_text` is NOT trimmed: the server does not trim it
 * either, and its byte budget is measured on exactly these bytes.
 */
export function preferenceThemePayload(theme: PreferenceCenterTheme): {
  logo_url: string;
  primary_color: string;
  footer_text: string;
  show_postwave_badge: boolean;
} {
  return {
    logo_url: theme.logoUrl.trim(),
    primary_color: theme.primaryColor.trim(),
    footer_text: theme.footerText,
    show_postwave_badge: theme.showPostwaveBadge,
  };
}

/** Two themes differ in a field the PATCH carries. */
export function preferenceThemeDirty(
  left: PreferenceCenterTheme,
  right: PreferenceCenterTheme,
): boolean {
  return (
    left.logoUrl !== right.logoUrl ||
    left.primaryColor !== right.primaryColor ||
    left.footerText !== right.footerText ||
    left.showPostwaveBadge !== right.showPostwaveBadge
  );
}

/* ── The colour ─────────────────────────────────────────────────────────── */

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/u;

/**
 * What the server will actually store. `validate()` treats an empty
 * primary_color as "reset to default" (preference_center.go:111) rather than a
 * refusal, so an emptied field previews — and saves as — the default.
 */
export function preferenceThemeEffectiveColor(
  theme: PreferenceCenterTheme,
): string {
  const trimmed = theme.primaryColor.trim();
  return trimmed === "" ? PREFERENCE_THEME_DEFAULTS.primaryColor : trimmed;
}

/** WCAG contrast of white on `hex`, or null when the hex is not one. */
export function preferenceThemeContrast(hex: string): number | null {
  if (!HEX_COLOR.test(hex)) return null;
  const channel = (start: number): number => {
    const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return 1.05 / (luminance + 0.05);
}

/* ── The logo URL ───────────────────────────────────────────────────────── */

/**
 * Re-exported so this module stays the one place a caller has to know about.
 * The rule itself lives in ./preferenceCenterLogoUrl, which is a whole
 * responsibility of its own: a verified mirror of Go's net/url + net.IP.
 */
export { preferenceLogoUrlAccepted } from "./preferenceCenterLogoUrl";

/* ── The footer ─────────────────────────────────────────────────────────── */

/**
 * `unicode.IsControl` (Cc) plus the Cf and Cs categories, minus the three
 * whitespace controls validate() explicitly continues past.
 */
const FOOTER_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const FOOTER_ALLOWED_CONTROLS = /[\n\r\t]/gu;

/** Bytes this footer will cost against the server's 4096-byte budget. */
export function preferenceFooterBytes(footerText: string): number {
  return utf8ByteLength(footerText);
}

/* ── The one verdict the card asks for ──────────────────────────────────── */

/**
 * The first reason this draft cannot be saved, in the order the Go validator
 * checks them (logo, then colour, then footer length, then footer characters),
 * so the sentence a local pre-check shows is the sentence the server would have
 * sent. Returns null when the draft is savable.
 */
export function preferenceThemeIssue(
  theme: PreferenceCenterTheme,
): PreferenceThemeIssue | null {
  if (!preferenceLogoUrlAccepted(theme.logoUrl)) {
    return { field: "logoUrl", message: SERVER_LOGO_REFUSAL };
  }
  if (!HEX_COLOR.test(preferenceThemeEffectiveColor(theme))) {
    return { field: "primaryColor", message: SERVER_COLOR_REFUSAL };
  }
  if (
    preferenceFooterBytes(theme.footerText) >
    PREFERENCE_THEME_LIMITS.footerMaxBytes
  ) {
    return { field: "footerText", message: SERVER_FOOTER_LONG_REFUSAL };
  }
  if (
    FOOTER_FORBIDDEN.test(theme.footerText.replace(FOOTER_ALLOWED_CONTROLS, ""))
  ) {
    return { field: "footerText", message: SERVER_FOOTER_CONTROL_REFUSAL };
  }
  return null;
}

/**
 * The readability warning for this colour, or null when it clears 4.5:1 (or is
 * not a hex the server would accept - that is a refusal, not a warning).
 */
export function preferenceThemeContrastAdvisory(
  theme: PreferenceCenterTheme,
): PreferenceThemeAdvisory | null {
  const ratio = preferenceThemeContrast(preferenceThemeEffectiveColor(theme));
  if (ratio === null || ratio >= PREFERENCE_THEME_LIMITS.minContrastRatio) {
    return null;
  }
  return {
    field: "primaryColor",
    ratio,
    message: `White button text has ${ratio.toFixed(2)}:1 contrast on this colour, under the 4.5:1 readability floor. The API accepts it; the desktop editor refuses to save it.`,
  };
}

/**
 * The sentence a failed save shows. A 422 from this route carries the
 * validator's own words, so they are rendered verbatim rather than re-worded;
 * only the two failures with no useful server sentence get one of ours.
 */
export function preferenceThemeSaveError(error: {
  status: number;
  code?: string | undefined;
  message: string;
}): string {
  if (error.status === 403) {
    return "Only workspace admins can change the preference-centre theme.";
  }
  const message = error.message?.trim() ?? "";
  if (message) return message;
  return "Couldn't save the preference-centre theme.";
}
