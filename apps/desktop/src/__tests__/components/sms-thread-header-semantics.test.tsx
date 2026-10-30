// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SMSConversationContext } from "../../lib/api-client";
import { ThreadHeader } from "../../components/sms/ThreadHeader";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderHeader(
  context: SMSConversationContext | null,
  loading = false,
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ThreadHeader phone="+12025550118" context={context} loading={loading} />,
    ),
  );
}

describe("ThreadHeader context semantics", () => {
  it("makes compliance posture and subscriber context directly visible", async () => {
    renderHeader({
      tenantId: "10000000-0000-4000-8000-000000000001",
      phoneE164: "+12025550118",
      subscriberEmail: "person@example.invalid",
      consentStatus: "opted_out",
      consentSource: "keyword",
      consentAt: "2026-07-01T10:00:00Z",
      subscribedLists: 2,
      firstSeenAt: "2026-06-01T10:00:00Z",
      totalMessages: 12,
      consentMixed: false,
      identityAmbiguous: false,
      consentEvidenceSufficient: false,
      suppressed: false,
      suppressionReversible: false,
      hasInboundThread: true,
      eligibleLists: [],
      replyDispatchAvailable: false,
      replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
    });

    expect(document.body.textContent).toContain("+1 (202) 555-0118");
    expect(document.body.textContent).toContain("Consent revoked");
    expect(document.body.textContent).toContain(
      "The loaded consent record is revoked. Reply is structurally locked.",
    );
    expect(document.body.textContent).toContain(
      "Subscriber: person@example.invalid",
    );
    expect(document.body.textContent).toContain(
      "No exact eligible SMS list in this loaded context",
    );
    expect(document.body.textContent).toContain("12 retained message records");
    expect(document.querySelector("[title]")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("states loading and missing context instead of leaving a blank strip", () => {
    renderHeader(null, true);
    expect(document.body.textContent).toContain("Loading subscriber context…");
    act(() => {
      root?.render(
        <ThreadHeader phone="+12025550118" context={null} loading={false} />,
      );
    });
    expect(document.body.textContent).toContain(
      "No subscriber context found for this phone.",
    );
    expect(document.body.textContent).toContain("No verified consent");
    expect(document.body.textContent).toContain(
      "No verified eligible SMS list is recorded in the loaded context.",
    );
  });
});
