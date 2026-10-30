import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("webhook scroll-region accessibility contract", () => {
  it("names and keyboard-enables every event catalog sample", () => {
    const catalog = source("components/webhooks/EventCatalogDialog.tsx");

    expect(catalog).toMatch(
      /<pre[\s\S]*?className="wh-verification-snippet"[\s\S]*?role="region"[\s\S]*?aria-label=\{`\$\{catalogEntry\.event\} representative signed body`\}[\s\S]*?tabIndex=\{0\}/u,
    );
  });

  it("names and keyboard-enables both inbound signature framing regions", () => {
    for (const path of [
      "components/InboundWebhookDetailSlideover.tsx",
      "pages/InboundWebhooks.tsx",
    ]) {
      const framing = source(path);
      expect(framing).toMatch(
        /<pre[\s\S]*?className="wh-framing-code"[\s\S]*?role="region"[\s\S]*?aria-label="Inbound webhook HMAC v2 signature framing"[\s\S]*?tabIndex=\{0\}[\s\S]*?<code>/u,
      );
    }
  });

  it("provides visible focus and contrast-safe light-theme entrance motion", () => {
    const webhookStyles = source("styles-webhooks.css");
    const sharedStyles = source("styles/shared-overlays.css");

    expect(webhookStyles).toContain(".wh-verification-snippet:focus-visible");
    expect(webhookStyles).toContain(".wh-framing-code:focus-visible");
    expect(webhookStyles).toContain("outline: 2px solid var(--pw-ring)");

    expect(sharedStyles).toContain(
      "@media (prefers-reduced-motion: no-preference) and (forced-colors: none)",
    );
    expect(sharedStyles).toContain(".stat-strip-v2 {");
    expect(sharedStyles).toContain(".value-prop-card {");

    const opaqueKeyframes =
      sharedStyles.match(
        /@keyframes pw-enter-(?:surface|content)-opaque \{[\s\S]*?\n\}/gu,
      ) ?? [];
    expect(opaqueKeyframes).toHaveLength(2);
    for (const keyframes of opaqueKeyframes) {
      expect(keyframes).not.toContain("opacity");
    }
  });
});
