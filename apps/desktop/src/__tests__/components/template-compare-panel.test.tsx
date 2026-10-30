// @vitest-environment happy-dom

import { act } from "react";
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

import type { CampaignTemplate } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  listCollections: vi.fn(),
  compare: vi.fn(),
}));

vi.mock("../../lib/api/campaign-template-discovery", () => ({
  campaignTemplateDiscoveryApi: {
    listCollections: mocks.listCollections,
    compare: mocks.compare,
  },
}));

import {
  TemplateComparePanel,
  templateEditingAvailability,
  templateFavoriteState,
  templatePreviewAvailability,
  templateProvenance,
} from "../../components/templates/TemplateComparePanel";

function template(
  id: string,
  name: string,
  input: Partial<CampaignTemplate> = {},
): CampaignTemplate {
  return {
    id,
    slug: id,
    name,
    subject: `${name} subject`,
    ...input,
  };
}

function comparisonItem(row: CampaignTemplate) {
  return {
    requested_identifier: row.id,
    matched_by: "id" as const,
    template: row,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.compare.mockReset();
  mocks.listCollections.mockReset();
  mocks.listCollections.mockResolvedValue({ data: { items: [] } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("TemplateComparePanel", () => {
  it("presents only reported decision capabilities and provenance", () => {
    const reported = template("template-a", "Reported", {
      template_kind: "reference",
      is_favorited: true,
      source_brand: "Acme",
      source_provider: "reallygoodemails",
      capabilities: {
        can_preview: true,
        can_favorite: true,
        can_adapt: true,
        can_use_directly: false,
        can_create_campaign: false,
        can_edit_directly: false,
        can_clone: false,
        can_delete: false,
        can_archive: false,
        can_restore: false,
        has_source_html: false,
        has_source_mjml: false,
        has_desktop_preview: true,
        has_mobile_preview: false,
      },
    });
    const assetsOnly = template("template-b", "Assets only", {
      preview_assets: [
        {
          variant: "desktop",
          url: "https://cdn.example/desktop.png",
          mime_type: "image/png",
          width: 600,
          height: 900,
          size_bytes: 1_000,
          status: "ready",
        },
        {
          variant: "mobile",
          url: "https://cdn.example/mobile.png",
          mime_type: "image/png",
          width: 320,
          height: 900,
          size_bytes: 900,
          status: "source_missing",
        },
      ],
    });

    expect(templateEditingAvailability(reported)).toBe("Adaptation only");
    expect(templateFavoriteState(reported)).toBe("Favorited");
    expect(templateProvenance(reported)).toBe("Acme · reallygoodemails");
    expect(templatePreviewAvailability(reported, "desktop")).toBe("Available");
    expect(templatePreviewAvailability(reported, "mobile")).toBe("Unavailable");
    expect(templatePreviewAvailability(assetsOnly, "desktop")).toBe(
      "Available",
    );
    expect(templatePreviewAvailability(assetsOnly, "mobile")).toBe(
      "Unavailable",
    );
    expect(templateEditingAvailability(assetsOnly)).toBe("Not reported");
    expect(templateFavoriteState(assetsOnly)).toBe("Not reported");
    expect(templateProvenance(assetsOnly)).toBe("Not reported");
  });

  it("does not let an older compare response overwrite a newer selection", async () => {
    const first = deferred<{
      data: {
        items: ReturnType<typeof comparisonItem>[];
        unavailable_identifiers: string[];
      };
    }>();
    const second = deferred<{
      data: {
        items: ReturnType<typeof comparisonItem>[];
        unavailable_identifiers: string[];
      };
    }>();
    mocks.compare
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const rowA = template("template-a", "Alpha");
    const rowB = template("template-b", "Beta");
    const rowC = template("template-c", "Gamma");
    const render = (selection: string[]) => {
      root?.render(
        <TemplateComparePanel
          compareSelection={selection}
          enabled
          rows={[rowA, rowB, rowC]}
          onCompareSelectionChange={() => undefined}
          onOpenTemplate={() => undefined}
        />,
      );
    };

    await act(async () => {
      render([rowA.id, rowB.id]);
    });
    const compareButton = () =>
      [...(container?.querySelectorAll("button") ?? [])].find((button) =>
        button.textContent?.includes("Compare selected"),
      ) as HTMLButtonElement;
    act(() => {
      compareButton().click();
    });

    await act(async () => {
      render([rowA.id, rowC.id]);
    });
    act(() => {
      compareButton().click();
    });

    await act(async () => {
      second.resolve({
        data: {
          items: [
            comparisonItem(template(rowA.id, "Newest Alpha")),
            comparisonItem(template(rowC.id, "Newest Gamma")),
          ],
          unavailable_identifiers: [],
        },
      });
      await second.promise;
    });
    expect(container?.textContent).toContain("Newest Gamma");

    await act(async () => {
      first.resolve({
        data: {
          items: [
            comparisonItem(template(rowA.id, "Older Alpha")),
            comparisonItem(template(rowB.id, "Older Beta")),
          ],
          unavailable_identifiers: [],
        },
      });
      await first.promise;
    });

    expect(container?.textContent).toContain("Newest Gamma");
    expect(container?.textContent).not.toContain("Older Beta");
    expect(mocks.compare).toHaveBeenNthCalledWith(1, [rowA.id, rowB.id]);
    expect(mocks.compare).toHaveBeenNthCalledWith(2, [rowA.id, rowC.id]);
  });

  it("shows design metadata, collection membership, and ingestion quality", async () => {
    const rowA = template("template-a", "Alpha", {
      style: "editorial",
      layout: "single-column",
      industry: "technology",
      review_status: "approved",
      quality_score: 0.92,
    });
    const rowB = template("template-b", "Beta");
    mocks.compare.mockResolvedValueOnce({
      data: {
        items: [comparisonItem(rowA), comparisonItem(rowB)],
        unavailable_identifiers: [],
      },
    });
    mocks.listCollections.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "collection-1",
            name: "Launch shortlist",
            template_ids: [rowA.id],
          },
        ],
      },
    });
    await act(async () => {
      root?.render(
        <TemplateComparePanel
          compareSelection={[rowA.id, rowB.id]}
          enabled
          rows={[rowA, rowB]}
          onCompareSelectionChange={() => undefined}
          onOpenTemplate={() => undefined}
        />,
      );
    });
    const run = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Compare selected"),
    );
    await act(async () => {
      run?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container?.textContent).toContain("Style: editorial");
    expect(container?.textContent).toContain("Layout: single-column");
    expect(container?.textContent).toContain("Industry: technology");
    expect(container?.textContent).toContain("Launch shortlist");
    expect(container?.textContent).toContain("ingestion quality 92%");
  });

  it("announces and removes templates that became unavailable", async () => {
    const rowA = template("template-a", "Alpha");
    const rowB = template("template-b", "Beta");
    const onSelectionChange = vi.fn();
    mocks.compare.mockResolvedValueOnce({
      data: {
        items: [comparisonItem(rowA)],
        unavailable_identifiers: [rowB.id],
      },
    });
    await act(async () => {
      root?.render(
        <TemplateComparePanel
          compareSelection={[rowA.id, rowB.id]}
          enabled
          rows={[rowA, rowB]}
          onCompareSelectionChange={onSelectionChange}
          onOpenTemplate={() => undefined}
        />,
      );
    });
    const run = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Compare selected"),
    );
    await act(async () => {
      run?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSelectionChange).toHaveBeenCalledWith([rowA.id]);
    expect(container?.textContent).toContain(
      "Beta is no longer available and was removed",
    );
    expect(container?.textContent).toContain(
      "Add another available template to continue.",
    );
  });
});
