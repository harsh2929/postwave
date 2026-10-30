import { describe, expect, it } from "vitest";

import {
  participantStatusPresentation,
  participantsSectionState,
  stuckRowSpoken,
  stuckSectionState,
} from "./sequenceParticipants";

describe("participantStatusPresentation", () => {
  it("maps every status the handler can emit", () => {
    expect(participantStatusPresentation("active").label).toBe("Active");
    expect(participantStatusPresentation("completed").label).toBe("Completed");
    expect(participantStatusPresentation("completed_goal").label).toBe(
      "Goal met",
    );
    expect(participantStatusPresentation("exited").label).toBe("Exited");
  });

  it("never invents a reading for an unknown status", () => {
    expect(participantStatusPresentation("teleported").label).toBe("Unknown");
    expect(participantStatusPresentation(undefined).label).toBe("Unknown");
  });
});

describe("participantsSectionState", () => {
  const base = {
    loading: false,
    status: 0,
    rowCount: 0,
    filter: "all" as const,
    runtimeQualified: false,
  };

  it("attributes an empty list to the missing runtime, not to the filter", () => {
    const state = participantsSectionState(base);
    expect(state.kind).toBe("empty");
    expect(state.message).toContain("not qualified");
  });

  it("blames the filter only once enrollment can actually happen", () => {
    const state = participantsSectionState({
      ...base,
      runtimeQualified: true,
      filter: "active",
    });
    expect(state.title).toBe("No one in this state");
    expect(state.message).toContain("different status filter");
  });

  it("treats 403 as a scope answer with no retry", () => {
    const state = participantsSectionState({ ...base, status: 403 });
    expect(state.kind).toBe("error");
    expect(state.retryable).toBe(false);
    expect(state.message).toContain("campaign and subscriber access");
  });

  it("treats 503 as a temporary dependency, retryable", () => {
    const state = participantsSectionState({ ...base, status: 503 });
    expect(state.retryable).toBe(true);
    expect(state.message).toContain("durable database");
  });

  it("treats an unmounted route as non-retryable", () => {
    for (const status of [404, 405, 501]) {
      expect(participantsSectionState({ ...base, status }).retryable).toBe(
        false,
      );
    }
  });

  it("passes the transport message through for anything else", () => {
    expect(
      participantsSectionState({ ...base, status: 500, message: "boom" })
        .message,
    ).toBe("boom");
  });

  it("reports rows when there are rows", () => {
    expect(participantsSectionState({ ...base, rowCount: 3 }).kind).toBe("rows");
  });

  it("reports loading before anything else", () => {
    expect(
      participantsSectionState({ ...base, loading: true, status: 500 }).kind,
    ).toBe("loading");
  });
});

describe("stuckSectionState", () => {
  const base = {
    loading: false,
    status: 0,
    rowCount: 0,
    thresholdDays: 3,
    runtimeQualified: false,
  };

  it("reads the handler's 400 as 'detection off', never as an error", () => {
    const state = stuckSectionState({ ...base, status: 400 });
    expect(state.kind).toBe("off");
    expect(state.title).toBe("Stuck detection is off");
    expect(state).not.toHaveProperty("retryable");
  });

  it("explains an empty report by the missing runtime", () => {
    expect(stuckSectionState(base).message).toContain("Nothing enrols");
  });

  it("names the threshold once the runtime can enrol", () => {
    expect(
      stuckSectionState({ ...base, runtimeQualified: true, thresholdDays: 1 })
        .message,
    ).toBe("No active participant has been idle for 1 day.");
  });

  it("keeps 403 non-retryable and 503 retryable", () => {
    expect(stuckSectionState({ ...base, status: 403 }).retryable).toBe(false);
    expect(stuckSectionState({ ...base, status: 503 }).retryable).toBe(true);
  });

  it("reports rows when there are rows", () => {
    expect(stuckSectionState({ ...base, rowCount: 2 }).kind).toBe("rows");
  });
});

describe("stuckRowSpoken", () => {
  it("says the compacted numbers out loud", () => {
    expect(
      stuckRowSpoken({ email: "a@b.co", current_step: 3, idle_days: 12 }),
    ).toBe("a@b.co. On step 3. Idle 12 days.");
  });

  it("singularises one day and floors a nonsensical step", () => {
    expect(
      stuckRowSpoken({ email: "a@b.co", current_step: 0, idle_days: 1 }),
    ).toBe("a@b.co. On step 1. Idle 1 day.");
  });
});
