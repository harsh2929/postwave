import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CampaignSaveTemplateModal,
  CampaignScheduleModal,
  CampaignSendConfirmationModal,
  EngagementModeToggle,
  toCampaignDateTimeLocal,
} from "../../components/CampaignDetailActionModals";
import type { CampaignDetail } from "../../lib/api-client";

const setBoolean = (): void => undefined;
const setString = (): void => undefined;

describe("campaign detail action boundaries", () => {
  it("normalizes valid recommendations without manufacturing NaN dates", () => {
    expect(toCampaignDateTimeLocal("2026-07-20T09:15:00")).toBe(
      "2026-07-20T09:15",
    );
    expect(toCampaignDateTimeLocal("not-a-date")).toBe("not-a-date");
  });

  it("keeps failing-checklist sends non-overrideable and gated", () => {
    const html = renderToStaticMarkup(
      <CampaignSendConfirmationModal
        confirmSendOpen
        setConfirmSendOpen={setBoolean}
        detail={detail({ segment_id: "segment-123456789" })}
        id="campaign-1"
        checklistEvidence={{
          status: "not-ready",
          campaignId: "campaign-1",
          requestId: 1,
        }}
        retryChecklist={() => undefined}
        audiencePreviewEvidence={{
          status: "idle",
          campaignId: null,
          requestId: 0,
        }}
        setAudiencePreviewEvidence={() => undefined}
        checklistFailureOverride={false}
        setChecklistFailureOverride={setBoolean}
        busy={false}
        canMutate
        authoringLocked={false}
        detailErr={null}
        send={async () => undefined}
      />,
    );
    expect(html).toContain("Send campaign?");
    expect(html).toContain("Failed checklist items cannot be overridden");
    expect(html).not.toContain(
      "I reviewed the failed checks and accept the risk",
    );
    expect(html).toContain("segment-…");
    expect(html).toContain("resolve them before sending");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain(" title=");
  });

  it("keeps a stale-open schedule modal explicitly and natively unavailable", () => {
    const html = renderToStaticMarkup(
      <CampaignScheduleModal
        scheduleOpen
        setScheduleOpen={setBoolean}
        detail={detail()}
        id={null}
        setScheduleAt={setString}
        scheduleAt="2026-07-20T09:00"
        pstoOn
        setPstoOn={setBoolean}
        pstoWindowStart="2026-07-20T09:00"
        setPstoWindowStart={setString}
        pstoWindowEnd="2026-07-20T17:00"
        setPstoWindowEnd={setString}
        busy={false}
        pstoSaving
        scheduleDiscardConfirmOpen={false}
        keepScheduleDraft={() => undefined}
        discardScheduleDraft={() => undefined}
        schedule={async () => undefined}
      />,
    );
    expect(html).toContain("Schedule send");
    expect(html).toContain('id="cam-schedule-at"');
    expect(html).toContain('id="cam-psto-start"');
    expect(html).toContain('id="cam-psto-end"');
    expect(html).toContain("Personalize send time within a window");
    expect(html).toContain("Scheduling is unavailable");
    expect(html).toContain("Scheduling unavailable");
    expect(html).toContain("durable delivery and recovery are being verified");
    expect(
      html.match(/aria-describedby="campaign-scheduling-availability"/gu)
        ?.length,
    ).toBeGreaterThanOrEqual(5);
    expect(html.match(/disabled=""/gu)?.length).toBeGreaterThanOrEqual(6);
  });

  it("revokes send confirmation when live write authority changes", () => {
    const html = renderToStaticMarkup(
      <CampaignSendConfirmationModal
        confirmSendOpen
        setConfirmSendOpen={setBoolean}
        detail={detail()}
        id="campaign-1"
        checklistEvidence={{
          status: "ready",
          campaignId: "campaign-1",
          requestId: 1,
        }}
        retryChecklist={() => undefined}
        audiencePreviewEvidence={{
          status: "idle",
          campaignId: null,
          requestId: 0,
        }}
        setAudiencePreviewEvidence={() => undefined}
        checklistFailureOverride={false}
        setChecklistFailureOverride={setBoolean}
        busy={false}
        canMutate={false}
        authoringLocked={false}
        detailErr={null}
        send={async () => undefined}
      />,
    );

    expect(html).toContain("Your current role cannot send campaigns");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send now<\/button>/);
  });

  it("preserves template validation feedback and busy-state controls", () => {
    const html = renderToStaticMarkup(
      <CampaignSaveTemplateModal
        tplModalOpen
        setTplModalOpen={setBoolean}
        tplSaving
        tplName="Launch template"
        setTplName={setString}
        tplSlug="launch-template"
        setTplSlug={setString}
        tplErr="Slug already exists"
        setTplErr={() => undefined}
        commitSaveAsTemplate={async () => undefined}
        canMutate
        canAdmin
        authoringLocked={false}
      />,
    );
    expect(html).toContain("Save as template");
    expect(html).toContain("Slug already exists");
    expect(html).toContain("launch-template");
    expect(html).toContain("Saving…");
  });

  it("keeps an open template draft inspectable but read-only after admin downgrade", () => {
    const html = renderToStaticMarkup(
      <CampaignSaveTemplateModal
        tplModalOpen
        setTplModalOpen={setBoolean}
        tplSaving={false}
        tplName="Launch template"
        setTplName={setString}
        tplSlug="launch-template"
        setTplSlug={setString}
        tplErr={null}
        setTplErr={() => undefined}
        commitSaveAsTemplate={async () => undefined}
        canMutate
        canAdmin={false}
        authoringLocked={false}
      />,
    );

    expect(html).toContain("requires the admin role");
    expect(html.match(/readOnly=""/gu)?.length).toBe(2);
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Save template<\/button>/,
    );
    expect(html).toContain("Cancel");
  });

  it("keeps the engagement toggle keyboard-readable", () => {
    const html = renderToStaticMarkup(
      <EngagementModeToggle value="raw" onChange={() => undefined} />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Engagement mode"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain("All opens + clicks, no bot filtering");
    expect(html).not.toContain(" title=");
    expect(html).toContain("Raw");
    expect(html).toContain("Human");
  });
});

function detail(overrides: Partial<CampaignDetail> = {}): CampaignDetail {
  return {
    id: "campaign-1",
    name: "Launch",
    status: "draft",
    ...overrides,
  } as CampaignDetail;
}
