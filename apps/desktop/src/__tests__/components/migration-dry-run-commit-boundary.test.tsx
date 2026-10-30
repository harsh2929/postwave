// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DryRunPreview,
  migrationDryRunCommitBlockedReason,
} from "../../components/migration/DryRunPreview";
import type { MigrationPreview } from "../../lib/api-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function verifiedPreview(
  overrides: Partial<MigrationPreview> = {},
): MigrationPreview {
  return {
    subscribers_imported: 12,
    data_loss_estimate_pct: 0,
    resource_completeness: [
      {
        resource: "subscribers",
        label: "Subscribers",
        source_total: 12,
        imported: 12,
        supported: true,
        status: "imported_runtime",
      },
    ],
    ...overrides,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function primaryAction(): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (button) =>
      button.textContent?.includes("real import") ||
      button.textContent?.includes("Import unavailable"),
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error("Missing dry-run primary action");
  }
  return match;
}

describe("migration dry-run commit boundary", () => {
  it("blocks a report with no verified resource inventory", () => {
    const preview = verifiedPreview({
      subscribers_imported: 0,
      resource_completeness: [],
    });

    expect(migrationDryRunCommitBlockedReason(preview, false)).toContain(
      "did not verify any countable source resources",
    );
  });

  it("blocks absent completeness and absent loss evidence without invoking commit", () => {
    const onConfirm = vi.fn();
    render(
      <DryRunPreview
        jobId="job_dry_run_unverified"
        source="mailchimp"
        sourceLabel="Mailchimp"
        preview={{ subscribers_imported: 12 }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const action = primaryAction();
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "resource-completeness evidence",
    );
    act(() => action.click());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks malformed resource rows and an out-of-range loss estimate", () => {
    const malformed = verifiedPreview({
      resource_completeness: [
        {
          resource: "subscribers",
          label: "Subscribers",
          source_total: Number.NaN,
          imported: 12,
          supported: true,
          status: "imported_runtime",
        },
      ],
    });
    expect(migrationDryRunCommitBlockedReason(malformed, true)).toContain(
      "malformed resource-completeness evidence",
    );

    const invalidLoss = verifiedPreview({ data_loss_estimate_pct: 101 });
    expect(migrationDryRunCommitBlockedReason(invalidLoss, true)).toContain(
      "verified 0–100% data-loss estimate",
    );
  });

  it("blocks unknown states, duplicate resources, impossible totals, and count mismatches", () => {
    expect(
      migrationDryRunCommitBlockedReason(
        verifiedPreview({
          resource_completeness: [
            {
              resource: "subscribers",
              label: "Subscribers",
              source_total: 12,
              imported: 12,
              supported: true,
              status: "nonsense",
            },
          ],
        }),
        true,
      ),
    ).toContain("malformed resource-completeness evidence");

    expect(
      migrationDryRunCommitBlockedReason(
        verifiedPreview({
          resource_completeness: [
            ...verifiedPreview().resource_completeness!,
            ...verifiedPreview().resource_completeness!,
          ],
        }),
        true,
      ),
    ).toContain("malformed resource-completeness evidence");

    expect(
      migrationDryRunCommitBlockedReason(
        verifiedPreview({
          resource_completeness: [
            {
              ...verifiedPreview().resource_completeness![0]!,
              source_total: 11,
              imported: 12,
            },
          ],
        }),
        true,
      ),
    ).toContain("malformed resource-completeness evidence");

    expect(
      migrationDryRunCommitBlockedReason(
        verifiedPreview({
          resource_completeness: [
            {
              ...verifiedPreview().resource_completeness![0]!,
              imported: 11,
              status: "partial_runtime",
            },
          ],
        }),
        true,
      ),
    ).toContain("do not reconcile");
  });

  it("allows an explicitly complete report, including a known non-zero loss estimate", () => {
    const onConfirm = vi.fn();
    render(
      <DryRunPreview
        jobId="job_dry_run_verified"
        source="mailchimp"
        sourceLabel="Mailchimp"
        preview={verifiedPreview({ data_loss_estimate_pct: 1.25 })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const action = primaryAction();
    expect(action.getAttribute("aria-disabled")).toBeNull();
    act(() => action.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does not confuse rebuild evidence with executable automation counts", () => {
    const preview = verifiedPreview({
      automations_translated: 0,
      resource_completeness: [
        ...verifiedPreview().resource_completeness!,
        {
          resource: "automations",
          label: "Flow rebuild evidence",
          source_total: 4,
          imported: 4,
          supported: true,
          status: "preserved_for_rebuild",
        },
        {
          resource: "forms",
          label: "Manual form rebuild evidence",
          source_total: 1,
          imported: 1,
          supported: false,
          status: "manual_rebuild_required",
        },
      ],
    });
    expect(
      migrationDryRunCommitBlockedReason(preview, true, "klaviyo"),
    ).toBeNull();
    expect(
      migrationDryRunCommitBlockedReason(preview, true, "mailchimp"),
    ).toContain("do not reconcile");
  });
});
