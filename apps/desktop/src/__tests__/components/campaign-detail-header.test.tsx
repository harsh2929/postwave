import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CampaignDetailHeader,
  campaignStatusBadge,
  defaultCampaignScheduleAt,
  personalizedWindowTitle,
} from "../../components/CampaignDetailHeader";
import type { CampaignDetail } from "../../lib/api-client";

describe("campaign detail header and actions", () => {
  it("formats the default schedule exactly one hour ahead in local time", () => {
    expect(defaultCampaignScheduleAt(new Date(2026, 6, 20, 9, 15))).toBe(
      "2026-07-20T10:15",
    );
  });

  it("reports personalized-window provenance without inventing dates", () => {
    expect(personalizedWindowTitle(detail())).toBe(
      "Each recipient sent at their best hour within the send window",
    );
    expect(
      personalizedWindowTitle(
        detail({
          send_window_start: "2026-07-20T09:00:00Z",
          send_window_end: "2026-07-20T17:00:00Z",
        }),
      ),
    ).toContain("between");
  });

  it("keeps status badges honest for known and unknown states", () => {
    const sent = renderToStaticMarkup(campaignStatusBadge("running"));
    expect(sent).toContain("Sent");
    expect(sent).toContain("badge success");
    expect(renderToStaticMarkup(campaignStatusBadge("failed"))).toContain(
      "badge danger",
    );
    expect(renderToStaticMarkup(campaignStatusBadge("cancelled"))).toContain(
      "cancelled",
    );
  });

  it("renders the complete draft action set and disables stale mutations", () => {
    const html = renderHeader({ detailErr: "gateway offline" });

    expect(html).toContain("Launch");
    expect(html).toContain("Edit");
    expect(html).toContain("Schedule");
    expect(html).toContain("Send");
    expect(html).toContain("Duplicate");
    expect(html).toContain("Save as template");
    expect(html).toContain("Translate");
    expect(html).toContain("UTM");
    expect(html).toContain("Delete");
    expect(html).toContain("gateway offline");
    expect(html).toContain(
      "Actions are unavailable until the latest campaign detail reloads.",
    );
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain(" title=");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps scheduling visible but fail-closed with an explicit reason", () => {
    const html = renderHeader();

    expect(html).toContain(">Schedule</button>");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Schedule<\/button>/);
    expect(html).toContain(
      "Scheduling is temporarily unavailable while durable delivery and recovery are being verified.",
    );
    expect(html).toContain("aria-describedby=");
  });

  it("natively locks persisted actions while the editor is open and explains why", () => {
    const html = renderHeader({ authoringLocked: true });

    expect(html).toContain(
      "Save or cancel the open editor before acting on the persisted campaign.",
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Duplicate<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete<\/button>/);
  });

  it("exposes pause and terminal cancel controls for an active send", () => {
    const html = renderHeader({
      campaign: detail({ status: "sending" }),
      isDraft: false,
      canPauseSend: true,
      canCancelSend: true,
    });

    expect(html).toContain("Pause");
    expect(html).toContain("Cancel send");
    expect(html).toContain("Pausing holds queued messages");
    expect(html).toContain("cannot be undone");
    expect(html).not.toContain(">Schedule<");
  });
});

function renderHeader(
  overrides: {
    campaign?: CampaignDetail;
    isDraft?: boolean;
    canPauseSend?: boolean;
    canResumeSend?: boolean;
    canCancelSend?: boolean;
    detailErr?: string | null;
    authoringLocked?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <CampaignDetailHeader
      detail={overrides.campaign ?? detail()}
      isDraft={overrides.isDraft ?? true}
      canPauseSend={overrides.canPauseSend ?? false}
      canResumeSend={overrides.canResumeSend ?? false}
      canCancelSend={overrides.canCancelSend ?? false}
      busy={false}
      canMutate
      canAdmin
      authoringLocked={overrides.authoringLocked ?? false}
      detailErr={overrides.detailErr ?? null}
      scheduleAt=""
      onScheduleAtChange={() => undefined}
      onEdit={() => undefined}
      onOpenSchedule={() => undefined}
      onOpenSend={() => undefined}
      onRunControl={async () => undefined}
      onDuplicate={async () => undefined}
      onSaveAsTemplate={() => undefined}
      onTranslate={() => undefined}
      onUtm={() => undefined}
      onOpenCancel={() => undefined}
      onOpenDelete={() => undefined}
    />,
  );
}

function detail(overrides: Partial<CampaignDetail> = {}): CampaignDetail {
  return {
    id: "campaign-1",
    name: "Launch",
    subject: "The launch is here",
    status: "draft",
    ...overrides,
  } as CampaignDetail;
}
