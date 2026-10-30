import { describe, expect, it } from "vitest";

import { helpdeskClaimAction, helpdeskClaimLabel } from "./helpdesk";

const me = "11111111-1111-4111-8111-111111111111";
const colleague = "22222222-2222-4222-8222-222222222222";

describe("helpdesk assignment actions", () => {
  it("offers server-derived assign_self for an unassigned conversation", () => {
    expect(
      helpdeskClaimAction(
        { assignmentState: "unassigned", assignedToUserId: null },
        me,
      ),
    ).toBe("claim");
    expect(helpdeskClaimLabel("claim")).toBe("Assign to me");
  });

  it("offers explicit unassign when the stable member UUID is mine", () => {
    expect(
      helpdeskClaimAction(
        { assignmentState: "tenant_active_user", assignedToUserId: me },
        me,
      ),
    ).toBe("unassign");
    expect(
      helpdeskClaimAction(
        {
          assignmentState: "tenant_active_user",
          assignedToUserId: me.toUpperCase(),
        },
        me,
      ),
    ).toBe("unassign");
    expect(helpdeskClaimLabel("unassign")).toBe("Unassign");
  });

  it("calls replacing another member a takeover", () => {
    expect(
      helpdeskClaimAction(
        {
          assignmentState: "tenant_active_user",
          assignedToUserId: colleague,
        },
        me,
      ),
    ).toBe("takeover");
    expect(helpdeskClaimLabel("takeover")).toBe("Take over");
  });

  it("offers an explicit takeover without inventing a legacy assignee", () => {
    expect(
      helpdeskClaimAction(
        { assignmentState: "legacy_unverified", assignedToUserId: null },
        me,
      ),
    ).toBe("takeover");
  });

  it("offers no identity-derived write without a known viewer UUID", () => {
    for (const viewer of [null, undefined, "", "   "]) {
      expect(
        helpdeskClaimAction(
          { assignmentState: "unassigned", assignedToUserId: null },
          viewer,
        ),
      ).toBe("none");
    }
    expect(helpdeskClaimLabel("none")).toBeNull();
  });
});
