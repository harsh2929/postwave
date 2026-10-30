// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  canWrite: false,
  listDiscounts: vi.fn(),
  listArchive: vi.fn(),
  listCampaigns: vi.fn(),
  getArchiveStats: vi.fn(),
  getArchiveTenantSettings: vi.fn(),
  listArchiveComments: vi.fn(),
  listTags: vi.fn(),
  listTagTaxonomy: vi.fn(),
  listTagGroups: vi.fn(),
  auditSessionReplay: vi.fn(),
  getInclusionProof: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useCanWrite: () => mocks.canWrite,
  useCanAdmin: () => false,
}));

vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({ hasScope: () => true }),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listArchive: mocks.listArchive,
      listCampaigns: mocks.listCampaigns,
      getArchiveStats: mocks.getArchiveStats,
      getArchiveTenantSettings: mocks.getArchiveTenantSettings,
      listArchiveComments: mocks.listArchiveComments,
      listTags: mocks.listTags,
      listTagTaxonomy: mocks.listTagTaxonomy,
      listTagGroups: mocks.listTagGroups,
      auditSessionReplay: mocks.auditSessionReplay,
      getInclusionProof: mocks.getInclusionProof,
    },
    apiMonetization: {
      ...actual.apiMonetization,
      listDiscounts: mocks.listDiscounts,
    },
  };
});

import { AuditEventSlideover } from "../../components/AuditEventSlideover";
import type { AuditRow } from "../../lib/api-client";
import { Archive } from "../../pages/Archive";
import { Discounts } from "../../pages/Discounts";
import { Tags } from "../../pages/Tags";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canWrite = false;
  for (const [key, mock] of Object.entries(mocks)) {
    if (key !== "canWrite" && typeof mock === "function") mock.mockReset();
  }
  mocks.listDiscounts.mockResolvedValue({
    data: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        label: "Discount record 11111111",
        percent_off: 20,
        currency: "USD",
        applies_to: "first_payment",
        times_redeemed: 3,
        created_at: "2026-07-01T10:00:00Z",
      },
    ],
  });
  mocks.listArchive.mockResolvedValue({
    data: {
      items: [
        {
          slug: "launch",
          subject: "Launch issue",
          publishedAt: "2026-07-01T10:00:00Z",
          pinned: false,
        },
      ],
    },
  });
  mocks.listCampaigns.mockResolvedValue({ data: { items: [] } });
  mocks.getArchiveStats.mockResolvedValue({ data: {} });
  mocks.getArchiveTenantSettings.mockResolvedValue({ data: {} });
  mocks.listArchiveComments.mockResolvedValue({ data: { items: [] } });
  mocks.listTags.mockResolvedValue({
    data: {
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "vip",
          color: "teal",
          description: "High-intent subscribers",
          created_at: "2026-07-01T10:00:00Z",
          updated_at: "2026-07-01T10:00:00Z",
          pii: false,
          version: 1,
          etag: '"tag:22222222-2222-4222-8222-222222222222:v1"',
        },
      ],
    },
  });
  mocks.listTagTaxonomy.mockResolvedValue({
    data: {
      items: [
        { tag: "vip", subscribers: 10, registered: true },
        { tag: "legacy", subscribers: 2, registered: false },
      ],
    },
  });
  mocks.listTagGroups.mockResolvedValue({ data: { items: [] } });
  mocks.auditSessionReplay.mockResolvedValue({ data: { available: false } });
  mocks.getInclusionProof.mockResolvedValue({
    data: {
      leaf_id: 1,
      leaf_hash: "leaf",
      root_hash: "root",
      audit_path: [],
      tree_size: 1,
      anchored_at: "2026-07-01T10:00:00Z",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

describe("interactive title remediation wave 1", () => {
  it("removes discount mutation theatre and states the historical boundary", async () => {
    render(<Discounts />);
    await settle();
    expect(
      document.querySelector<HTMLHeadingElement>("#discount-history-title")
        ?.textContent,
    ).toContain("without inventing checkout truth");
    expect(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Inspect Discount record 11111111"]',
      ),
    ).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("button")).some((candidate) =>
        /new discount|edit|duplicate|disable/iu.test(
          candidate.textContent?.trim() ?? "",
        ),
      ),
    ).toBe(false);
    expect(document.body.textContent).toContain(
      "Nothing on this route creates, edits, redeems, disables, or provider-verifies a discount.",
    );
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
  });

  it("makes archive URL prerequisites and tag permissions keyboard discoverable", async () => {
    render(<Archive />);
    await settle();
    const copy = button("Copy URL");
    expect(copy.disabled).toBe(false);
    expect(copy.getAttribute("aria-disabled")).toBe("true");
    expect(copy.getAttribute("aria-describedby")).toBe(
      "archive-public-url-availability",
    );
    act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();

    render(<Tags />);
    await settle();
    const edit = button("Edit");
    expect(edit.disabled).toBe(false);
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("aria-describedby")).toBe(
      "tags-write-availability",
    );
    const colourGroup = Array.from(document.querySelectorAll("fieldset")).find(
      (fieldset) => fieldset.textContent?.includes("Filter tags by colour"),
    );
    expect(colourGroup?.querySelectorAll('input[type="radio"]')).toHaveLength(
      9,
    );
  });

  it("gives inclusion-proof generation one same-tick owner and stays axe-clean", async () => {
    let resolveProof!: (value: {
      data: {
        leaf_id: number;
        leaf_hash: string;
        root_hash: string;
        audit_path: never[];
        tree_size: number;
        anchored_at: string;
      };
    }) => void;
    mocks.getInclusionProof.mockReturnValue(
      new Promise((resolve) => {
        resolveProof = resolve;
      }),
    );
    const row = {
      id: "audit-1",
      action: "campaign.updated",
      actorType: "human",
      actorLabel: "Alice",
      at: "2026-07-01T10:00:00Z",
      metadata: {},
    } as AuditRow;
    render(<AuditEventSlideover row={row} onClose={vi.fn()} />);
    await settle();
    const generate = button("Generate proof for this event");
    act(() => {
      generate.click();
      generate.click();
    });
    expect(mocks.getInclusionProof).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
    await act(async () => {
      resolveProof({
        data: {
          leaf_id: 1,
          leaf_hash: "leaf",
          root_hash: "root",
          audit_path: [],
          tree_size: 1,
          anchored_at: "2026-07-01T10:00:00Z",
        },
      });
      await Promise.resolve();
    });
  });
});
