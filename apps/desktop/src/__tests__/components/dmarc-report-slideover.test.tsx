// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DmarcReportSlideover } from "../../components/DmarcReportSlideover";
import type { DmarcReport } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const zeroReport: DmarcReport = {
  id: "11111111-1111-4111-8111-111111111111",
  orgName: "Mailbox Example",
  reportId: "provider-report-01",
  domain: "example.test",
  policyP: "none",
  policyPct: 0,
  dateBegin: "2026-08-01T00:00:00.000Z",
  dateEnd: "2026-08-02T00:00:00.000Z",
  passCount: 0,
  failCount: 0,
  receivedAt: "2026-08-02T02:00:00.000Z",
};

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
  document.body.style.overflow = "";
});

function Harness(): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open report evidence
      </button>
      {open ? (
        <DmarcReportSlideover
          report={zeroReport}
          returnFocusRef={triggerRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("DmarcReportSlideover", () => {
  it("shows minimized evidence, avoids a manufactured percentage, and restores focus", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<Harness />));
    const trigger = document.querySelector<HTMLButtonElement>("button")!;
    trigger.focus();
    act(() => trigger.click());
    await settle();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("No denominator");
    expect(dialog?.textContent).toContain(
      "No alignment percentage is inferred",
    );
    expect(dialog?.textContent).toContain("Legacy pct observation0%");
    expect(dialog?.textContent).toContain(
      "removed from the current DMARC specification",
    );
    expect(dialog?.textContent).toContain("not a live DNS observation");
    expect(dialog?.textContent).not.toContain("Raw report");
    expect(dialog?.textContent).not.toContain("orgEmail");

    const results = await axe.run(dialog!);
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    const close = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )!;
    act(() => close.click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
