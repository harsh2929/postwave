import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const page = readFileSync(
  new URL("../../pages/InboundRoutes.tsx", import.meta.url),
  "utf8",
);
const controller = readFileSync(
  new URL(
    "../../pages/inbound-routes/useInboundRoutesController.ts",
    import.meta.url,
  ),
  "utf8",
);
const endpointCard = readFileSync(
  new URL(
    "../../pages/inbound-routes/InboundEndpointCard.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("inbound routes lifecycle source contract", () => {
  it("protects one-time endpoint plaintext and every local destructive transition", () => {
    expect(endpointCard).toContain("useShownOnceSecretLifecycle(");
    expect(endpointCard).toContain("Copy and clear");
    expect(endpointCard).toContain("I&apos;ve stored it securely");
    expect(endpointCard).toContain('title="Discard the one-time secret?"');
    expect(endpointCard).toContain('title="Rotate inbound signing secret?"');
    expect(endpointCard).toContain("Discard reveal and rotate");
    expect(page).toContain("inbound-route-draft-${mode}-");
    expect(page).toContain("inbound-route-preview-draft-${instanceId}");
    expect(page).toContain('"close" | "history" | null');
    expect(page).toContain("Discard changes and view history?");
    expect(page).not.toContain("prepare:");
  });

  it("never journals plaintext and zeroizes new HMAC values", () => {
    expect(`${page}\n${endpointCard}\n${controller}`).not.toMatch(
      /localStorage|sessionStorage|indexedDB|console\.(?:log|info|warn|error)/u,
    );
    expect(page).toContain('hmac_secret: ""');
    expect(page).toContain("zeroizeHmacDrafts");
    expect(page).toContain(
      "A secret is already configured but is never pre-filled",
    );
    expect(page).toContain("remove_hmac_secret");
    expect(page).toMatch(/zeroizeHmacDrafts\(\);[\s\S]*await onSaved\(\)/u);
  });

  it("keeps controller mutations instance-safe, single-flight, contained, and alive across unmount", () => {
    expect(controller).toContain("activeOperationsRef.current.has(key)");
    expect(controller).toContain(
      "active-operation-inbound-routes-${instanceId}-${key}",
    );
    expect(controller).toContain(
      "Do not unregister them merely because a typed route unmounted this page.",
    );
    expect(controller).toContain("actionsForDisabledDuplicate(route)");
    expect(controller).toContain("hmac_secret: _secret");
    expect(controller).toMatch(
      /const toggleEnabled[\s\S]*try \{[\s\S]*catch \{[\s\S]*finally \{[\s\S]*finishOperation\(key\)/u,
    );
    expect(controller).toMatch(
      /const rotateEndpoint[\s\S]*try \{[\s\S]*catch \{[\s\S]*finally \{[\s\S]*finishOperation\(ENDPOINT_ROTATE_OPERATION\)/u,
    );
    expect(controller).not.toMatch(/catch \(error\)|catch \(err\)/u);
  });
});
