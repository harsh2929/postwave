/**
 * The rule half of SMS conversation triage.
 *
 * The inbox rendered Snoozed / Archived filter chips with live server counts
 * and had no verb to move a row into either, so the first thing worth pinning
 * is that the menu AGREES WITH THE CHIP: the state a row is offered under has
 * to be derived by the same predicate the list filter uses, or an operator can
 * open "Archive" on a row the server already considers archived.
 *
 * Expectations here are written by hand from the server's own semantics
 * (apps/api/internal/sms/inbox_extras.go:100-137) rather than derived from the
 * module under test.
 */
import { describe, expect, it } from "vitest";

import {
  SMS_SNOOZE_PRESETS,
  smsAssignmentLine,
  smsConversationLifecycle,
  smsLifecycleLine,
  smsTriageDoneMessage,
  smsTriageIntentFor,
  smsTriageOptions,
  snoozeUntilIso,
} from "./smsTriageOptions";

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const ME = "11111111-1111-4111-8111-111111111111";
const SOMEONE_ELSE = "22222222-2222-4222-8222-222222222222";
const PHONE = "+15555550123";

function ids(options: readonly { id: string }[]): string[] {
  return options.map((option) => option.id);
}

describe("smsConversationLifecycle", () => {
  it("treats an archived conversation as archived even while a snooze is live", () => {
    expect(
      smsConversationLifecycle(
        {
          archivedAt: new Date(NOW - 60_000).toISOString(),
          snoozeUntil: new Date(NOW + 3_600_000).toISOString(),
        },
        NOW,
      ),
    ).toBe("archived");
  });

  it("does not call a conversation snoozed once its deadline has passed", () => {
    expect(
      smsConversationLifecycle(
        { snoozeUntil: new Date(NOW - 1).toISOString() },
        NOW,
      ),
    ).toBe("active");
    expect(
      smsConversationLifecycle(
        { snoozeUntil: new Date(NOW + 1).toISOString() },
        NOW,
      ),
    ).toBe("snoozed");
  });

  it("is active when neither stamp is present", () => {
    expect(smsConversationLifecycle({}, NOW)).toBe("active");
  });
});

describe("the sentences a row may render", () => {
  it("says nothing for an active conversation rather than badging every row", () => {
    expect(smsLifecycleLine({}, NOW, () => "never called")).toBeNull();
  });

  it("names the snooze deadline with the caller's formatter", () => {
    const until = new Date(NOW + 3_600_000).toISOString();
    expect(
      smsLifecycleLine({ snoozeUntil: until }, NOW, (iso) => `<${iso}>`),
    ).toBe(`Snoozed until <${until}>`);
  });

  it("distinguishes my assignment from a teammate's without inventing a name", () => {
    expect(smsAssignmentLine({ assigneeUserId: ME }, ME)).toBe(
      "Assigned to you",
    );
    expect(smsAssignmentLine({ assigneeUserId: SOMEONE_ELSE }, ME)).toBe(
      "Assigned to a teammate",
    );
    expect(smsAssignmentLine({}, ME)).toBeNull();
    // No signed-in id is known: the row must not claim the assignment is mine.
    expect(smsAssignmentLine({ assigneeUserId: ME }, null)).toBe(
      "Assigned to a teammate",
    );
  });
});

describe("smsTriageOptions", () => {
  it("offers Archive but not Restore for an active conversation", () => {
    const options = ids(
      smsTriageOptions({ conversation: {}, now: NOW, currentUserId: ME }),
    );
    expect(options).toContain("archive");
    expect(options).not.toContain("unarchive");
    expect(options).not.toContain("unsnooze");
    expect(options).toContain("assign_me");
    expect(options).not.toContain("unassign");
  });

  it("leads a snoozed conversation with Wake now and never offers Archive twice", () => {
    const options = ids(
      smsTriageOptions({
        conversation: { snoozeUntil: new Date(NOW + 60_000).toISOString() },
        now: NOW,
        currentUserId: ME,
      }),
    );
    expect(options[0]).toBe("unsnooze");
    expect(options).toContain("archive");
    expect(options.filter((id) => id === "archive")).toHaveLength(1);
  });

  it("offers Restore and not Archive for an archived conversation", () => {
    const options = ids(
      smsTriageOptions({
        conversation: { archivedAt: new Date(NOW - 1).toISOString() },
        now: NOW,
        currentUserId: ME,
      }),
    );
    expect(options).toContain("unarchive");
    expect(options).not.toContain("archive");
  });

  it("offers to take over a conversation held by someone else, and to drop mine", () => {
    const theirs = ids(
      smsTriageOptions({
        conversation: { assigneeUserId: SOMEONE_ELSE },
        now: NOW,
        currentUserId: ME,
      }),
    );
    expect(theirs).toContain("assign_me");
    expect(theirs).toContain("unassign");

    const mine = ids(
      smsTriageOptions({
        conversation: { assigneeUserId: ME },
        now: NOW,
        currentUserId: ME,
      }),
    );
    expect(mine).not.toContain("assign_me");
    expect(mine).toContain("unassign");
  });

  it("never offers Assign to me when no signed-in user id is available", () => {
    expect(
      ids(
        smsTriageOptions({ conversation: {}, now: NOW, currentUserId: null }),
      ),
    ).not.toContain("assign_me");
  });

  it("offers the full verb set when the lifecycle state is unknown", () => {
    const options = ids(
      smsTriageOptions({ conversation: null, now: NOW, currentUserId: ME }),
    );
    for (const id of [
      "unsnooze",
      "snooze_1h",
      "snooze_8h",
      "snooze_24h",
      "archive",
      "unarchive",
      "assign_me",
      "unassign",
    ]) {
      expect(options).toContain(id);
    }
  });
});

describe("snoozeUntilIso", () => {
  it("is the preset's own offset from the supplied clock, in UTC", () => {
    expect(snoozeUntilIso("snooze_1h", NOW)).toBe(
      new Date(NOW + 3_600_000).toISOString(),
    );
    expect(snoozeUntilIso("snooze_24h", NOW)).toBe(
      new Date(NOW + 86_400_000).toISOString(),
    );
  });

  it("covers every preset the menu can render", () => {
    for (const preset of SMS_SNOOZE_PRESETS) {
      expect(Date.parse(snoozeUntilIso(preset.id, NOW))).toBe(NOW + preset.ms);
    }
  });
});

describe("smsTriageIntentFor", () => {
  it("maps each preset onto a snooze with a future deadline", () => {
    expect(
      smsTriageIntentFor("snooze_8h", {
        phoneE164: PHONE,
        now: NOW,
        currentUserId: ME,
      }),
    ).toEqual({
      action: "snooze",
      phoneE164: PHONE,
      until: new Date(NOW + 8 * 3_600_000).toISOString(),
    });
  });

  it("sends the signed-in id for a self-assign and null for a clear", () => {
    expect(
      smsTriageIntentFor("assign_me", {
        phoneE164: PHONE,
        now: NOW,
        currentUserId: ME,
      }),
    ).toEqual({ action: "assign", phoneE164: PHONE, userId: ME });
    expect(
      smsTriageIntentFor("unassign", {
        phoneE164: PHONE,
        now: NOW,
        currentUserId: ME,
      }),
    ).toEqual({ action: "assign", phoneE164: PHONE, userId: null });
  });

  it("refuses a self-assign it cannot address rather than sending an empty id", () => {
    expect(() =>
      smsTriageIntentFor("assign_me", {
        phoneE164: PHONE,
        now: NOW,
        currentUserId: null,
      }),
    ).toThrow(/signed-in user id/iu);
  });

  it("maps the plain lifecycle verbs one to one", () => {
    const base = { phoneE164: PHONE, now: NOW, currentUserId: ME };
    expect(smsTriageIntentFor("unsnooze", base)).toEqual({
      action: "unsnooze",
      phoneE164: PHONE,
    });
    expect(smsTriageIntentFor("archive", base)).toEqual({
      action: "archive",
      phoneE164: PHONE,
    });
    expect(smsTriageIntentFor("unarchive", base)).toEqual({
      action: "unarchive",
      phoneE164: PHONE,
    });
  });
});

describe("smsTriageDoneMessage", () => {
  it("speaks in the past tense for every option the menu can offer", () => {
    const every = ids(
      smsTriageOptions({ conversation: null, now: NOW, currentUserId: ME }),
    );
    for (const id of every) {
      const message = smsTriageDoneMessage(id as never);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
    expect(smsTriageDoneMessage("archive")).toBe("Archived.");
    expect(smsTriageDoneMessage("unsnooze")).toBe("Back in Active.");
  });
});
