// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory mocks for the cross-client render API. Used when
// `NEXT_PUBLIC_USE_MOCKS=1`.
// The image URLs all point at `placehold.co`, which renders a labeled
// placeholder box of the requested dimensions.

import type { RenderEnvironment, RenderResponse, RenderedClient } from "./render-types";

const ENVIRONMENTS: Array<Omit<RenderedClient, "image_url" | "issues">> = [
  { environment: { name: "outlook_2019_desktop", viewport_width: 900, viewport_height: 1200, user_agent: "Outlook 16.0", dark_mode: false }, width: 900, height: 600 },
  { environment: { name: "outlook_365_web", viewport_width: 1024, viewport_height: 1400, user_agent: "Outlook Web", dark_mode: false }, width: 1024, height: 700 },
  { environment: { name: "outlook_macos", viewport_width: 900, viewport_height: 1200, user_agent: "Outlook macOS", dark_mode: false }, width: 900, height: 600 },
  { environment: { name: "apple_mail_macos_light", viewport_width: 1024, viewport_height: 1400, user_agent: "Apple Mail", dark_mode: false }, width: 1024, height: 700 },
  { environment: { name: "apple_mail_macos_dark", viewport_width: 1024, viewport_height: 1400, user_agent: "Apple Mail", dark_mode: true }, width: 1024, height: 700 },
  { environment: { name: "apple_mail_ios", viewport_width: 390, viewport_height: 844, user_agent: "Apple Mail iOS", dark_mode: false }, width: 390, height: 422 },
  { environment: { name: "gmail_web_promotions", viewport_width: 1024, viewport_height: 1400, user_agent: "Gmail Web", dark_mode: false }, width: 1024, height: 700 },
  { environment: { name: "gmail_ios", viewport_width: 390, viewport_height: 844, user_agent: "Gmail iOS", dark_mode: false }, width: 390, height: 422 },
  { environment: { name: "yahoo_web", viewport_width: 1024, viewport_height: 1400, user_agent: "Yahoo Web", dark_mode: false }, width: 1024, height: 700 },
  { environment: { name: "proton_mail_web", viewport_width: 1024, viewport_height: 1400, user_agent: "ProtonMail", dark_mode: false }, width: 1024, height: 700 },
];

const SAMPLE_ISSUES: Record<RenderEnvironment, string[]> = {
  outlook_2019_desktop: [
    "border-radius is ignored in Outlook 2019; corners will appear square.",
    "@media queries are ignored in Outlook 2019 — design the desktop layout as the default.",
  ],
  outlook_365_web: [],
  outlook_macos: [],
  apple_mail_macos_light: [],
  apple_mail_macos_dark: [
    "Missing `color-scheme: light dark` declaration — Apple Mail will auto-invert your colors.",
  ],
  apple_mail_ios: [],
  gmail_web_promotions: [
    "Image-heavy body: verify readability with images blocked and run a real inbox-placement test.",
  ],
  gmail_ios: [],
  yahoo_web: [],
  proton_mail_web: [
    "ProtonMail blocks remote images by default; recipients see broken-image placeholders until they click Show Images.",
  ],
};

export function mockRenderResponse(html: string): RenderResponse {
  const tag = encodeURIComponent(html.length > 32 ? html.slice(0, 32) : html || "preview");
  return {
    cache_hit: false,
    render_mode: "placeholder",
    renders: ENVIRONMENTS.map((e) => ({
      environment: e.environment,
      width: e.width,
      height: e.height,
      image_url: `https://placehold.co/${e.width}x${e.height}/${e.environment.dark_mode ? "1c1c1e/f2f2f7" : "f4f4f5/0f172a"}/png?text=${e.environment.name}+${tag}`,
      issues: SAMPLE_ISSUES[e.environment.name as RenderEnvironment] ?? [],
    })),
  };
}
