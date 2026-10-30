// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import TemplateDetailPage from "@/app/(dashboard)/app/templates/[id]/page";
import type { CampaignTemplate } from "@/lib/campaign-templates-api";

const api = vi.hoisted(() => ({
  getCampaignTemplate: vi.fn(),
  getCampaignTemplateFlowUsage: vi.fn(),
  listCampaignTemplateRevisions: vi.fn(),
  listCampaigns: vi.fn(),
}));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-templates-api")>()),
  getCampaignTemplate: api.getCampaignTemplate,
  getCampaignTemplateFlowUsage: api.getCampaignTemplateFlowUsage,
  listCampaignTemplateRevisions: api.listCampaignTemplateRevisions,
}));

vi.mock("@/lib/campaigns-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaigns-api")>()),
  listCampaigns: api.listCampaigns,
}));

vi.mock("@/components/EmailPreview", () => ({ EmailPreview: () => null }));
vi.mock("@/components/copy-text-button", () => ({
  CopyTextButton: () => null,
}));
vi.mock("@/components/relative-time", () => ({ RelativeTime: () => null }));
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-capture-preview",
  () => ({ TemplateCapturePreview: () => null }),
);
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-restore-button",
  () => ({ TemplateRestoreButton: () => null }),
);
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-detail-actions",
  () => ({ TemplateDetailActions: () => null }),
);
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-detail-focus",
  () => ({ TemplateDetailFocus: () => null }),
);
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-view-recorder",
  () => ({ TemplateViewRecorder: () => null }),
);
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-actions",
  () => ({ AdaptTemplateDialog: () => null, UseTemplateDialog: () => null }),
);
vi.mock(
  "@/app/(dashboard)/app/templates/_components/template-preview",
  () => ({ TemplatePreviewFrame: () => null }),
);

const TEMPLATE: CampaignTemplate = {
  id: "template-1",
  tenant_id: "tenant-1",
  version: 2,
  etag: '"template-1-v2"',
  name: "Welcome",
  subject: "Welcome aboard",
  tags: [],
  source: "mine",
  template_kind: "editable",
  usage_count: 3,
  body_html: "<p>Hello</p>",
  variables: [],
  editable_regions: [],
};

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(
    await TemplateDetailPage({
      params: Promise.resolve({ id: TEMPLATE.id }),
      searchParams: Promise.resolve({ return_to: "/app/templates" }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getCampaignTemplate.mockResolvedValue(TEMPLATE);
});

describe("template detail secondary requests", () => {
  it("renders independent retryable errors instead of false empty states", async () => {
    api.listCampaigns.mockRejectedValue(new Error("campaign usage down"));
    api.getCampaignTemplateFlowUsage.mockRejectedValue(
      new Error("flow usage down"),
    );
    api.listCampaignTemplateRevisions.mockRejectedValue(
      new Error("revision history down"),
    );

    const html = await renderPage();

    expect(html).toContain("Campaign usage unavailable");
    expect(html).toContain("Flow usage unavailable");
    expect(html).toContain("Version history unavailable");
    expect(html).toContain('id="used-in-campaigns"');
    expect(html).toContain('href="#used-in-campaigns"');
    expect(html.match(/>Retry<\/a>/g)).toHaveLength(3);
  });

  it("does not render a hash link when a successful usage lookup has no target", async () => {
    api.listCampaigns.mockResolvedValue([]);
    api.getCampaignTemplateFlowUsage.mockResolvedValue([]);
    api.listCampaignTemplateRevisions.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      page_size: 8,
    });

    const html = await renderPage();

    expect(html).toContain("Used in 3 campaigns");
    expect(html).not.toContain('href="#used-in-campaigns"');
    expect(html).not.toContain('id="used-in-campaigns"');
  });
});
