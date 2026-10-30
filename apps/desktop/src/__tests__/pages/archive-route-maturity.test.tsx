// @vitest-environment happy-dom

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
  role: "viewer" as "admin" | "editor" | "viewer",
  publicDeliveryAvailable: false,
  listArchive: vi.fn(),
  listCampaigns: vi.fn(),
  getArchiveStats: vi.fn(),
  getArchiveTenantSettings: vi.fn(),
  getArchiveIssuePreview: vi.fn(),
  pinArchive: vi.fn(),
  unpinArchive: vi.fn(),
  publishCampaignArchive: vi.fn(),
  unpublishCampaignArchive: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useCanAdmin: () => mocks.role === "admin",
}));

vi.mock("../../lib/archive-operational-availability", () => ({
  get ARCHIVE_PUBLIC_DELIVERY_AVAILABLE() {
    return mocks.publicDeliveryAvailable;
  },
  ARCHIVE_COMMENTS_AVAILABLE: false,
  ARCHIVE_PRIVATE_PODCAST_AVAILABLE: false,
  ARCHIVE_PUBLIC_DELIVERY_UNAVAILABLE_REASON:
    "Public copy, open, RSS, and sitemap actions are review-gated while the archive web route and delivery host are converged.",
  ARCHIVE_COMMENTS_UNAVAILABLE_REASON: "Reader comments remain review-gated.",
  ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON:
    "Private feeds remain review-gated.",
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
      getArchiveIssuePreview: mocks.getArchiveIssuePreview,
      pinArchive: mocks.pinArchive,
      unpinArchive: mocks.unpinArchive,
      publishCampaignArchive: mocks.publishCampaignArchive,
      unpublishCampaignArchive: mocks.unpublishCampaignArchive,
    },
  };
});

vi.mock("../../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/tauri")>();
  return {
    ...actual,
    tauriApi: {
      ...actual.tauriApi,
      openUrl: mocks.openUrl,
    },
  };
});

import type { ArchiveIssue } from "../../lib/api-client";
import { Archive } from "../../pages/Archive";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const canonicalIssue: ArchiveIssue = {
  campaignId: "campaign-canonical",
  slug: "launch-notes",
  subject: "Launch notes",
  excerpt: "What changed in this release.",
  publishedAt: "2026-07-24T10:00:00.000Z",
  pinned: false,
};

const configuredArchive = {
  tenant_archive_slug: "acme",
  archive_domain: "",
  archive_title: "Acme dispatch",
  archive_tagline: "Notes from the team",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.role = "viewer";
  mocks.publicDeliveryAvailable = false;
  for (const value of Object.values(mocks)) {
    if (typeof value === "function") value.mockReset();
  }
  mocks.listArchive.mockResolvedValue({
    data: { items: [canonicalIssue] },
  });
  mocks.listCampaigns.mockResolvedValue({ data: { items: [] } });
  mocks.getArchiveStats.mockResolvedValue({ data: null });
  mocks.getArchiveTenantSettings.mockResolvedValue({
    data: configuredArchive,
  });
  mocks.getArchiveIssuePreview.mockResolvedValue({
    data: {
      slug: canonicalIssue.slug,
      subject: canonicalIssue.subject,
      htmlBody: "<p>Published snapshot</p>",
      publishedAt: canonicalIssue.publishedAt,
      campaignId: canonicalIssue.campaignId,
    },
  });
  mocks.pinArchive.mockResolvedValue({ data: {} });
  mocks.unpinArchive.mockResolvedValue({ data: {} });
  mocks.publishCampaignArchive.mockResolvedValue({ data: {} });
  mocks.unpublishCampaignArchive.mockResolvedValue({ data: {} });
  mocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.removeProperty("overflow");
  vi.clearAllMocks();
});

function render(element: ReactElement = <Archive />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/g, " ").trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function change(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

describe("Archive route maturity boundaries", () => {
  it.each(["viewer", "editor"] as const)(
    "aligns %s access with the API's admin-only mutation policy",
    async (role) => {
      mocks.role = role;
      render();
      await settle();

      expect(document.body.textContent).toContain("Review-only access");
      const pin = button("Pin Launch notes");
      expect(pin.disabled).toBe(false);
      expect(pin.getAttribute("aria-disabled")).toBe("true");
      act(() => pin.click());
      await settle();
      expect(mocks.pinArchive).not.toHaveBeenCalled();
      expect(mocks.unpinArchive).not.toHaveBeenCalled();

      const detailTrigger = button("View details for Launch notes");
      act(() => {
        detailTrigger.focus();
        detailTrigger.click();
      });
      await settle();

      const slug =
        document.querySelector<HTMLInputElement>("#archive-edit-slug");
      expect(slug?.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Your current role has view-only archive access.",
      );
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Unpublish issue",
        ),
      ).toBe(false);
      expect(mocks.publishCampaignArchive).not.toHaveBeenCalled();
      expect(mocks.unpublishCampaignArchive).not.toHaveBeenCalled();
    },
  );

  it("keeps publication and public links fail-closed for an admin with complete URL settings", async () => {
    const actualAvailability = await vi.importActual<
      typeof import("../../lib/archive-operational-availability")
    >("../../lib/archive-operational-availability");
    expect(actualAvailability.ARCHIVE_PUBLIC_DELIVERY_AVAILABLE).toBe(false);

    mocks.role = "admin";
    render();
    await settle();

    expect(mocks.getArchiveTenantSettings).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain("Publication is review-gated");
    const publish = button("Publish from campaign");
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    act(() => publish.click());
    expect(
      document.querySelector('[role="dialog"][aria-modal="true"]'),
    ).toBeNull();

    for (const label of [
      "Copy URL",
      "Copy RSS",
      "Copy sitemap",
      "Open archive",
    ]) {
      const publicAction = button(label);
      expect(publicAction.getAttribute("aria-disabled")).toBe("true");
      act(() => publicAction.click());
    }
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.publishCampaignArchive).not.toHaveBeenCalled();

    const pin = button("Pin Launch notes");
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    act(() => pin.click());
    await settle();
    expect(mocks.pinArchive).not.toHaveBeenCalled();
    expect(mocks.unpinArchive).not.toHaveBeenCalled();

    act(() => button("View details for Launch notes").click());
    await settle();
    expect(
      document.querySelector<HTMLInputElement>("#archive-edit-slug")?.disabled,
    ).toBe(true);
    expect(button("Save changes").getAttribute("aria-disabled")).toBe("true");
    expect(button("Pin to top").getAttribute("aria-disabled")).toBe("true");
    act(() => button("Unpublish issue").click());
    const confirmation = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"]',
      ),
    ).find((dialog) =>
      dialog.textContent?.includes("The issue will disappear from the public"),
    );
    const confirmUnpublish = Array.from(
      confirmation?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((candidate) => candidate.textContent?.trim() === "Unpublish issue");
    expect(confirmUnpublish).toBeTruthy();
    act(() => confirmUnpublish?.click());
    await settle();
    expect(mocks.unpublishCampaignArchive).toHaveBeenCalledWith(
      "campaign-canonical",
    );
  });

  it("admits only completed sends and enforces a required 64-character slug when the release gate is explicitly lifted", async () => {
    mocks.role = "admin";
    mocks.publicDeliveryAvailable = true;
    mocks.listCampaigns.mockResolvedValue({
      data: {
        items: [
          {
            id: "sent-campaign",
            subject:
              "A deliberately enormous launch title that exceeds the permanent path budget by a wide margin",
            status: "sent",
          },
          {
            id: "draft-campaign",
            subject: "Draft candidate",
            status: "draft",
          },
          {
            id: "scheduled-campaign",
            subject: "Scheduled candidate",
            status: "scheduled",
          },
          {
            id: "sending-campaign",
            subject: "Sending candidate",
            status: "sending",
          },
        ],
      },
    });
    render();
    await settle();

    act(() => button("Publish from campaign").click());
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-modal="true"]',
    );
    expect(dialog?.textContent).toContain("Publish from campaign");

    const campaign =
      document.querySelector<HTMLSelectElement>("#archive-campaign");
    expect(
      Array.from(campaign?.options ?? []).map((option) => option.value),
    ).toEqual(["", "sent-campaign"]);

    const slug = document.querySelector<HTMLInputElement>("#archive-slug");
    expect(slug?.required).toBe(true);
    expect(slug?.maxLength).toBe(64);
    change(campaign!, "sent-campaign");
    expect(slug?.value.length).toBe(64);
    expect(slug?.value).toMatch(/^[a-z0-9-]+$/);

    change(slug!, "");
    expect(button("Publish").disabled).toBe(true);
    change(slug!, `${"A".repeat(80)} unsafe suffix`);
    expect(slug?.value).toBe("a".repeat(64));
    expect(button("Publish").disabled).toBe(false);

    const excerpt =
      document.querySelector<HTMLTextAreaElement>("#archive-excerpt");
    change(excerpt!, "A stable public summary.");
    act(() => button("Publish").click());
    await settle();
    expect(mocks.publishCampaignArchive).toHaveBeenCalledWith("sent-campaign", {
      slug: "a".repeat(64),
      excerpt: "A stable public summary.",
    });
  });

  it("uses the canonical campaignId directly for list mutations", async () => {
    mocks.role = "admin";
    mocks.publicDeliveryAvailable = true;
    render();
    await settle();

    act(() => button("Pin Launch notes").click());
    await settle();

    expect(mocks.pinArchive).toHaveBeenCalledOnce();
    expect(mocks.pinArchive).toHaveBeenCalledWith("campaign-canonical");
    expect(mocks.getArchiveIssuePreview).not.toHaveBeenCalled();
  });

  it("saves only deliberate detail changes through the canonical campaign identity", async () => {
    mocks.role = "admin";
    mocks.publicDeliveryAvailable = true;
    render();
    await settle();

    act(() => button("Edit Launch notes").click());
    await settle();
    change(
      document.querySelector<HTMLTextAreaElement>("#archive-edit-excerpt")!,
      "A revised archive summary.",
    );
    act(() => button("Edit SEO + social preview").click());
    change(
      document.querySelector<HTMLInputElement>("#archive-edit-canonical")!,
      "https://example.com/original",
    );
    act(() => button("Save changes").click());
    await settle();

    expect(mocks.publishCampaignArchive).toHaveBeenCalledWith(
      "campaign-canonical",
      {
        slug: "launch-notes",
        excerpt: "A revised archive summary.",
        metaDescription: undefined,
        ogImage: undefined,
        heroImage: undefined,
        authorName: undefined,
        canonicalUrl: "https://example.com/original",
      },
    );
    expect(
      document.querySelector('aside[role="dialog"][aria-modal="true"]'),
    ).toBeNull();
  });

  it("never falls back to subject matching when campaign identity is absent", async () => {
    mocks.role = "admin";
    mocks.publicDeliveryAvailable = true;
    mocks.listArchive.mockResolvedValue({
      data: {
        items: [
          {
            slug: "duplicate-subject",
            subject: "Shared subject",
            excerpt: "No campaign identity is present.",
            publishedAt: canonicalIssue.publishedAt,
          },
        ],
      },
    });
    mocks.listCampaigns.mockResolvedValue({
      data: {
        items: [
          {
            id: "subject-match-must-not-win",
            subject: "Shared subject",
            status: "sent",
          },
        ],
      },
    });
    mocks.getArchiveIssuePreview.mockResolvedValue({
      data: {
        slug: "duplicate-subject",
        subject: "Shared subject",
        htmlBody: "<p>Legacy issue</p>",
        publishedAt: canonicalIssue.publishedAt,
      },
    });
    render();
    await settle();

    act(() => button("Pin Shared subject").click());
    await settle();

    expect(mocks.getArchiveIssuePreview).toHaveBeenCalledWith(
      "duplicate-subject",
    );
    expect(mocks.pinArchive).not.toHaveBeenCalled();
    expect(mocks.unpinArchive).not.toHaveBeenCalled();
  });

  it("retains last-good rows and labels the degraded refresh truthfully", async () => {
    mocks.listArchive
      .mockResolvedValueOnce({ data: { items: [canonicalIssue] } })
      .mockResolvedValueOnce({
        error: { message: "Archive upstream timed out." },
      });
    render();
    await settle();
    expect(document.body.textContent).toContain("Launch notes");

    act(() => button("Refresh catalog").click());
    await settle();

    expect(document.body.textContent).toContain("Launch notes");
    expect(
      document.querySelector('table[aria-label="Published archive issues"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "The issue catalog remains visible.",
    );
    expect(document.body.textContent).toContain("Archive upstream timed out.");
  });

  it("rejects a malformed archive projection instead of rendering fabricated rows", async () => {
    mocks.listArchive.mockResolvedValue({
      data: {
        items: [
          {
            slug: "malformed",
            subject: "Missing required fields",
            publishedAt: "not-a-date",
          },
        ],
      },
    });
    render();
    await settle();

    expect(document.body.textContent).toContain(
      "Archive data could not be loaded.",
    );
    expect(document.body.textContent).toContain("invalid core projection");
    expect(document.body.textContent).toContain(
      "No catalog data is available yet.",
    );
    expect(
      document.querySelector('table[aria-label="Published archive issues"]'),
    ).toBeNull();
  });

  it("fails campaign selection closed when its response collection is malformed", async () => {
    mocks.role = "admin";
    mocks.publicDeliveryAvailable = true;
    mocks.listCampaigns.mockResolvedValue({
      data: { items: { id: "not-an-array", status: "sent" } },
    });
    render();
    await settle();

    act(() => button("Publish from campaign").click());
    expect(document.body.textContent).toContain(
      "Campaigns could not be loaded: Campaign lookup returned a non-array “items” collection.",
    );
    expect(
      document.querySelector<HTMLSelectElement>("#archive-campaign")?.disabled,
    ).toBe(true);
    expect(button("Publish").disabled).toBe(true);
    expect(mocks.publishCampaignArchive).not.toHaveBeenCalled();
  });

  it("keeps partial statistics and settings failures unknown rather than inventing values", async () => {
    mocks.getArchiveStats.mockResolvedValue({
      error: { message: "Metrics service is unavailable." },
    });
    mocks.getArchiveTenantSettings.mockResolvedValue({
      error: { message: "Link settings could not be read." },
    });
    render();
    await settle();

    expect(document.body.textContent).toContain(
      "Performance totals are temporarily unavailable: Metrics service is unavailable.",
    );
    expect(document.body.textContent).toContain(
      "Public-link settings are temporarily unavailable: Link settings could not be read.",
    );
    const values = Array.from(
      document.querySelectorAll<HTMLElement>(".stat-strip-v2-value"),
    ).map((value) => value.textContent?.trim());
    expect(values).toEqual(["1", "—", "—", "—"]);
    expect(button("Open archive").getAttribute("aria-disabled")).toBe("true");
  });

  it("surfaces preview failure inside the standardized responsive, focus-managed slideover", async () => {
    mocks.role = "admin";
    mocks.getArchiveIssuePreview.mockResolvedValue({
      error: { message: "Preview renderer is unavailable." },
    });
    render();
    await settle();

    const trigger = button("View details for Launch notes");
    act(() => {
      trigger.focus();
      trigger.click();
    });
    await settle();

    const dialog = document.querySelector<HTMLElement>(
      'aside[role="dialog"][aria-modal="true"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.classList.contains("slideover-v2")).toBe(true);
    expect(dialog?.classList.contains("slideover-lg")).toBe(true);
    expect(dialog?.classList.contains("archive-detail-slideover")).toBe(true);
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Archive metadata could not be loaded: Preview renderer is unavailable.",
    );
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    const body = dialog?.querySelector<HTMLElement>(
      '.slideover-body[role="region"]',
    );
    expect(body).not.toBeNull();
    expect(body?.getAttribute("aria-labelledby")).toBe(
      dialog?.getAttribute("aria-labelledby"),
    );

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
    expect(
      document.querySelector('aside[role="dialog"][aria-modal="true"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
