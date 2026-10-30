import { describe, expect, it } from "vitest";

import {
  MAX_PUSH_ENTITY_ID_CHARS,
  parseNotificationAction,
} from "./pushNotificationAction";

type AnyResponse = Parameters<typeof parseNotificationAction>[0];

function response(
  data: unknown,
  actionIdentifier = "expo.modules.notifications.actions.DEFAULT",
): AnyResponse {
  return {
    actionIdentifier,
    notification: { request: { content: { data } } },
  } as unknown as AnyResponse;
}

describe("parseNotificationAction", () => {
  it("reads the flat contract the backend sender actually writes", () => {
    expect(
      parseNotificationAction(
        response(
          { event_type: "approval.requested", entity_id: "appr_123" },
          "postwave.approve",
        ),
      ),
    ).toEqual({
      actionIdentifier: "postwave.approve",
      eventType: "approval.requested",
      entityId: "appr_123",
    });
  });

  it("never promotes a nested body into an actionable command", () => {
    // `data` is assembled from customer-editable records. A legacy or hostile
    // nested shape must not be able to name the approval this device decides.
    const parsed = parseNotificationAction(
      response(
        {
          customer: { event_type: "approval.requested", entity_id: "appr_evil" },
          payload: { entity_id: "appr_evil" },
        },
        "postwave.approve",
      ),
    );
    expect(parsed).toEqual({
      actionIdentifier: "postwave.approve",
      eventType: "",
      entityId: "",
    });
  });

  it("drops non-string identifiers instead of coercing them", () => {
    expect(
      parseNotificationAction(
        response({ event_type: 7, entity_id: { id: "appr_1" } }),
      ),
    ).toMatchObject({ eventType: "", entityId: "" });
  });

  it("drops an oversized entity id rather than truncating it", () => {
    // Truncation would produce a DIFFERENT, possibly valid, id.
    const long = "a".repeat(MAX_PUSH_ENTITY_ID_CHARS + 1);
    expect(
      parseNotificationAction(response({ entity_id: long })),
    ).toMatchObject({ entityId: "" });
    expect(
      parseNotificationAction(
        response({ entity_id: "a".repeat(MAX_PUSH_ENTITY_ID_CHARS) }),
      ),
    ).toMatchObject({ entityId: "a".repeat(MAX_PUSH_ENTITY_ID_CHARS) });
  });

  it("returns null when there is nothing to act on at all", () => {
    expect(parseNotificationAction(null)).toBeNull();
    expect(parseNotificationAction(undefined)).toBeNull();
    expect(parseNotificationAction(response(undefined))).toBeNull();
    expect(parseNotificationAction(response("just a string"))).toBeNull();
    expect(
      parseNotificationAction({
        actionIdentifier: "x",
      } as unknown as AnyResponse),
    ).toBeNull();
  });

  it("carries the OS-collected reject reason through as userText", () => {
    // GOVERNANCE#37 — the Reject action is a `textInput` action, so the reason
    // arrives on the RESPONSE (not in `data`, which is server-authored).
    const parsed = parseNotificationAction({
      actionIdentifier: "reject",
      userText: "  Budget not approved for Q3  ",
      notification: {
        request: {
          content: { data: { event_type: "approval.requested", entity_id: "a1" } },
        },
      },
    } as unknown as AnyResponse);
    // Verbatim: trimming is the decision layer's job, not the parser's.
    expect(parsed?.userText).toBe("  Budget not approved for Q3  ");
    expect(parsed?.entityId).toBe("a1");
  });

  it("reports no text as undefined rather than an empty reason", () => {
    // "" would read as "the approver submitted an empty reason"; the two are
    // different and only one of them is the platform's fault.
    expect(
      parseNotificationAction(response({ event_type: "approval.requested" })),
    ).toMatchObject({ userText: undefined });
    expect(
      parseNotificationAction({
        actionIdentifier: "reject",
        userText: 42,
        notification: { request: { content: { data: { entity_id: "a1" } } } },
      } as unknown as AnyResponse)?.userText,
    ).toBeUndefined();
  });

  it("preserves a plain tap's default action identifier", () => {
    expect(
      parseNotificationAction(response({ event_type: "campaign.sent" })),
    ).toMatchObject({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      eventType: "campaign.sent",
      entityId: "",
    });
  });
});
