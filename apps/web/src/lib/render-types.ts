// SPDX-License-Identifier: AGPL-3.0-only
//
// Wire types for the cross-client render API. Mirrors
// `services/deliverability/internal/render`.

export type RenderEnvironment =
  | "outlook_2019_desktop"
  | "outlook_365_web"
  | "outlook_macos"
  | "apple_mail_macos_light"
  | "apple_mail_macos_dark"
  | "apple_mail_ios"
  | "gmail_web_promotions"
  | "gmail_ios"
  | "yahoo_web"
  | "proton_mail_web";

export interface RenderEnvironmentMeta {
  name: RenderEnvironment | string;
  viewport_width: number;
  viewport_height: number;
  user_agent: string;
  dark_mode: boolean;
}

export interface RenderedClient {
  environment: RenderEnvironmentMeta;
  image_url: string;
  width: number;
  height: number;
  issues: string[];
}

export interface RenderResponse {
  renders: RenderedClient[];
  cache_hit: boolean;
  /** Simulation is browser/CSS approximation; placeholder has no screenshot. */
  render_mode?: "simulation" | "placeholder" | "unverified";
}

export const ALL_ENVIRONMENTS: RenderEnvironment[] = [
  "outlook_2019_desktop",
  "outlook_365_web",
  "outlook_macos",
  "apple_mail_macos_light",
  "apple_mail_macos_dark",
  "apple_mail_ios",
  "gmail_web_promotions",
  "gmail_ios",
  "yahoo_web",
  "proton_mail_web",
];

export const ENVIRONMENT_LABELS: Record<RenderEnvironment, string> = {
  outlook_2019_desktop: "Outlook 2019 (Desktop)",
  outlook_365_web: "Outlook 365 (Web)",
  outlook_macos: "Outlook for macOS",
  apple_mail_macos_light: "Apple Mail (Light)",
  apple_mail_macos_dark: "Apple Mail (Dark)",
  apple_mail_ios: "Apple Mail (iOS)",
  gmail_web_promotions: "Gmail Web (Promotions)",
  gmail_ios: "Gmail (iOS)",
  yahoo_web: "Yahoo! Mail (Web)",
  proton_mail_web: "ProtonMail (Web)",
};

/**
 * Categorize an issue string as breaking ("red") or warning ("amber").
 * The deliverability checks return free-form strings; we use a small
 * keyword heuristic so the UI can color-code without coupling badge
 * shape to the backend wording.
 */
export function severityFor(issue: string): "breaking" | "warning" {
  const low = issue.toLowerCase();
  if (
    low.includes("not supported") ||
    low.includes("ignores") ||
    low.includes("ignored") ||
    low.includes("strips") ||
    low.includes("blocks") ||
    low.includes("not rendered") ||
    low.includes("auto-invert")
  ) {
    return "breaking";
  }
  return "warning";
}
