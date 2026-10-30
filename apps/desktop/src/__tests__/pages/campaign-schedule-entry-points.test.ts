import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every desktop schedule entry point must go through the lifecycle endpoint,
 * and must respect the shared availability gate.
 *
 * Two independent bugs met here:
 *
 *  1. Both desktop schedule writes — the calendar drag and the schedule modal —
 *     issued `PATCH /api/v1/campaigns/{id}` carrying `scheduled_at`. That
 *     endpoint refuses the field with 422 `campaign_dispatch_state_owned` and
 *     directs the caller to "campaign lifecycle endpoints", of which none
 *     existed for scheduled_at. So the shipped calendar write path failed on
 *     every drop, and the message named the wrong cause.
 *
 *  2. The drag was the one schedule entry point that never consulted
 *     CAMPAIGN_SCHEDULING_AVAILABLE, whose own file asks that it be shared with
 *     "every desktop schedule entry point so one surface cannot overstate what
 *     the delivery system can currently guarantee". The 422 was accidentally
 *     acting as that enforcement — which meant the gate's real reason (durable
 *     delivery is still being verified) never reached the operator.
 */

const mocks = vi.hoisted(() => ({
  scheduleCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  schedulingAvailable: { value: false },
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      scheduleCampaign: mocks.scheduleCampaign,
      updateCampaign: mocks.updateCampaign,
    },
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../lib/campaign-operational-availability", () => ({
  get CAMPAIGN_SCHEDULING_AVAILABLE() {
    return mocks.schedulingAvailable.value;
  },
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON:
    "Scheduling is temporarily unavailable while durable delivery and recovery are being verified. You can keep drafting and reviewing this campaign.",
}));

import type { Campaign } from "../../lib/api-client";
import { createCampaignRowActions } from "../../pages/campaigns/useCampaignRowActions";
import type { CampaignsData } from "../../pages/campaigns/useCampaignsData";
import type { CampaignsState } from "../../pages/campaigns/useCampaignsState";

const scheduled = {
  id: "campaign-1",
  name: "Launch",
  subject: "Launch now",
  status: "scheduled",
  // 09:00 local on a day before the US DST transition.
  scheduled_at: new Date(2026, 2, 1, 9, 0, 0).toISOString(),
} as Campaign;

function buildActions() {
  const data = {
    load: vi.fn().mockResolvedValue(undefined),
    loadFolders: vi.fn().mockResolvedValue(undefined),
  } as unknown as CampaignsData;
  const state = {
    moveTarget: null,
    setResendTarget: vi.fn(),
  } as unknown as CampaignsState;
  return createCampaignRowActions(state, data, {
    current: {
      canMutateCampaignSnapshot: true,
      canAdminMutateCampaignSnapshot: true,
    },
  });
}

describe("desktop campaign schedule entry points", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.schedulingAvailable.value = false;
    mocks.scheduleCampaign.mockResolvedValue({ data: scheduled });
    mocks.updateCampaign.mockResolvedValue({ data: scheduled });
  });

  it("refuses the calendar drag with the shared reason while scheduling is unavailable", async () => {
    const actions = buildActions();
    const moved = await actions.rescheduleFromCalendar(scheduled, "2026-03-15");

    expect(moved).toBe(false);
    expect(mocks.scheduleCampaign).not.toHaveBeenCalled();
    expect(mocks.updateCampaign).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("durable delivery"),
      }),
    );
  });

  it("uses the lifecycle endpoint, never PATCH, once scheduling is available", async () => {
    mocks.schedulingAvailable.value = true;
    const actions = buildActions();

    await actions.rescheduleFromCalendar(scheduled, "2026-03-15");

    expect(mocks.scheduleCampaign).toHaveBeenCalledTimes(1);
    // The regression that matters: PATCH refuses scheduled_at outright, so any
    // client that reaches for it is issuing a request that cannot succeed.
    expect(mocks.updateCampaign).not.toHaveBeenCalled();
    const [id, iso] = mocks.scheduleCampaign.mock.calls[0];
    expect(id).toBe("campaign-1");
    expect(typeof iso).toBe("string");
  });

  it("carries the wall-clock time across a DST boundary", async () => {
    // "Same time, different day" is what dropping a card on another square
    // means. Shifting the ISO instant by a fixed offset would move a 09:00 send
    // to 08:00 or 10:00 whenever the drag crosses a transition — the blueprint
    // lists this as a critical case for scheduled campaigns.
    //
    // The assertion is only meaningful in a zone that OBSERVES DST. CI runs UTC
    // and this repo's dev machines run IST, in both of which the naive
    // instant-shift and the correct wall-clock carry produce the same answer —
    // so without pinning TZ this test would pass against the very defect it
    // exists to catch. Skipped rather than silently vacuous.
    const observesDst =
      new Date(2026, 0, 1).getTimezoneOffset() !==
      new Date(2026, 6, 1).getTimezoneOffset();
    if (!observesDst) {
      // eslint-disable-next-line no-console
      console.warn(
        `DST assertion skipped: TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone} ` +
          "does not observe DST. Run with TZ=America/New_York to exercise it.",
      );
      return;
    }
    mocks.schedulingAvailable.value = true;
    const actions = buildActions();

    await actions.rescheduleFromCalendar(scheduled, "2026-03-15");

    const [, iso] = mocks.scheduleCampaign.mock.calls[0];
    const landed = new Date(iso as string);
    expect(landed.getHours()).toBe(9);
    expect(landed.getMinutes()).toBe(0);
    expect(landed.getFullYear()).toBe(2026);
    expect(landed.getMonth()).toBe(2);
    expect(landed.getDate()).toBe(15);
  });
});
