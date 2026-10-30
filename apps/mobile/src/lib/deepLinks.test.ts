/** Unit tests for routeForNotification and routeForAuthLink. */
import type { NotificationResponse } from "expo-notifications";
import { describe, expect, it } from "vitest";

import {
  planDeepLinkNavigation,
  routeForAuthLink,
  routeForDeviceApproveLink,
  routeForEntityLink,
  routeForNotification,
} from "./deepLinks";

type AnyResp = NotificationResponse | null | undefined;

function envelope(data: unknown): AnyResp {
  return {
    notification: {
      request: { content: { data: data as Record<string, unknown> } },
    },
  } as AnyResp;
}

const AUTH_LINK_SIGNATURE = "A".repeat(43);
const HELPDESK_CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function signedAuthUrl(
  base: string,
  flow: "magic" | "reset",
  options: { audience?: "mobile" | "web"; state?: string } = {},
): string {
  const audience = options.audience ?? "mobile";
  const query = new URLSearchParams({
    token: "abc123",
    v: "1",
    flow,
    aud: audience,
    sig: AUTH_LINK_SIGNATURE,
  });
  if (audience === "mobile") {
    query.set("state", options.state ?? "nonce123");
  }
  return base + "?" + query.toString();
}

function expectedAuthParams(
  flow: "magic" | "reset",
  audience: "mobile" | "web" = "mobile",
): Record<string, string> {
  return {
    token: "abc123",
    link_version: "1",
    link_flow: flow,
    link_audience: audience,
    ...(audience === "mobile" ? { state: "nonce123" } : {}),
    link_signature: AUTH_LINK_SIGNATURE,
    ...(audience === "web" ? { browser_fallback: "1" } : {}),
  };
}

describe("routeForNotification", () => {
  it("returns null for empty / malformed responses", () => {
    expect(routeForNotification(null)).toBeNull();
    expect(routeForNotification(undefined)).toBeNull();
    expect(routeForNotification(envelope(null))).toBeNull();
    expect(routeForNotification(envelope("not an object"))).toBeNull();
  });

  it("routes subscriber events to /subscribers/[id] when id is present", () => {
    const out = routeForNotification(
      envelope({
        event_type: "subscriber.unsubscribed",
        body: { id: "sub-123", email: "x@y.com" },
      }),
    );
    expect(out).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "sub-123" },
    });
  });

  it("falls back to subscribers list when subscriber payload is missing id", () => {
    const out = routeForNotification(
      envelope({ event_type: "subscriber.bounced", body: {} }),
    );
    expect(out).toBe("/(tabs)/subscribers");
  });

  it("does not place oversized subscriber ids into route params", () => {
    const out = routeForNotification(
      envelope({
        event_type: "subscriber.unsubscribed",
        body: { id: "sub_" + "x".repeat(300) },
      }),
    );

    expect(out).toBe("/(tabs)/subscribers");
  });

  it("routes a campaign event to THAT campaign's report when it carries an id", () => {
    // A "your campaign finished sending" push that lands on the list makes the
    // reader find the row the notification was already about.
    for (const event of [
      "campaign.sent",
      "campaign.opened",
      "campaign.clicked",
    ]) {
      expect(
        routeForNotification(
          envelope({ event_type: event, body: { id: "cmp-42" } }),
        ),
      ).toEqual({
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: "cmp-42" },
      });
    }
  });

  it("falls back to the campaigns tab when the envelope carries no id", () => {
    expect(
      routeForNotification(envelope({ event_type: "campaign.sent", body: {} })),
    ).toBe("/(tabs)/campaigns");
  });

  it("routes approval.requested to the request that fired it", () => {
    expect(
      routeForNotification(
        envelope({
          event_type: "approval.requested",
          body: { id: "apr-1", resourceType: "campaign", resourceId: "c-9" },
        }),
      ),
    ).toEqual({ pathname: "/(tabs)/approvals/[id]", params: { id: "apr-1" } });
  });

  it("accepts the actionable-push top-level entity_id for an approval", () => {
    expect(
      routeForNotification(
        envelope({
          event_type: "approval.requested",
          entity_id: "apr-2",
          body: {},
        }),
      ),
    ).toEqual({ pathname: "/(tabs)/approvals/[id]", params: { id: "apr-2" } });
  });

  it("falls back to the approvals queue when no id is on the envelope", () => {
    expect(
      routeForNotification(
        envelope({ event_type: "approval.requested", body: {} }),
      ),
    ).toBe("/(tabs)/approvals");
  });

  it.each(["automation.completed", "automation.failed", "sequence.generated"])(
    "lands %s on the sequence it is about",
    (event) => {
      // Every one of these is declared push-eligible in @postwave/notifications
      // with deepLinkEntity: "sequence", and mobile registers an `automations`
      // Android channel and offers the topics in settings — so a tap that landed
      // nowhere meant the whole chain existed and was joined to nothing.
      expect(
        routeForNotification(
          envelope({ event_type: event, body: { id: "seq-4" } }),
        ),
      ).toEqual({
        pathname: "/(tabs)/sequences/[id]",
        params: { id: "seq-4" },
      });
    },
  );

  it("accepts the actionable-push entity_id for an automation failure", () => {
    expect(
      routeForNotification(
        envelope({
          event_type: "automation.failed",
          entity_id: "seq-9",
          body: {},
        }),
      ),
    ).toEqual({ pathname: "/(tabs)/sequences/[id]", params: { id: "seq-9" } });
  });

  it("falls back to the sequences list when the automation envelope has no id", () => {
    expect(
      routeForNotification(
        envelope({ event_type: "sequence.generated", body: {} }),
      ),
    ).toBe("/(tabs)/sequences");
  });

  it.each(["form.submitted", "form.confirmed"])(
    "lands %s on the form it is about",
    (event) => {
      expect(
        routeForNotification(
          envelope({ event_type: event, body: { form_id: "form-7" } }),
        ),
      ).toEqual({
        pathname: "/(tabs)/forms/[id]",
        params: { id: "form-7" },
      });
    },
  );

  it("accepts camel-case and actionable-push form ids", () => {
    expect(
      routeForNotification(
        envelope({
          event_type: "form.submitted",
          body: { formId: "form-camel" },
        }),
      ),
    ).toEqual({
      pathname: "/(tabs)/forms/[id]",
      params: { id: "form-camel" },
    });

    expect(
      routeForNotification(
        envelope({
          event_type: "form.confirmed",
          entity_id: "form-push",
          body: {},
        }),
      ),
    ).toEqual({
      pathname: "/(tabs)/forms/[id]",
      params: { id: "form-push" },
    });
  });

  it("falls back to the forms list when no safe form id is present", () => {
    expect(
      routeForNotification(
        envelope({ event_type: "form.submitted", body: {} }),
      ),
    ).toBe("/(tabs)/forms");
    expect(
      routeForNotification(
        envelope({
          event_type: "form.confirmed",
          body: { form_id: "x".repeat(300) },
        }),
      ),
    ).toBe("/(tabs)/forms");
  });

  it("routes a new-device sign-in alert to Settings for active-session review", () => {
    expect(
      routeForNotification(
        envelope({
          event_type: "auth.new_device_sign_in",
          entity_id: "MDEyMzQ1Njc4OWFiY2RlZg",
        }),
      ),
    ).toBe("/(tabs)/settings");
  });

  it("returns null for unknown event types so caller skips navigation", () => {
    expect(
      routeForNotification(
        envelope({ event_type: "totally.unknown", body: {} }),
      ),
    ).toBeNull();
  });

  it("routes inbound SMS to its content-light list without using payload PII", () => {
    expect(
      routeForNotification(
        envelope({
          event_type: "sms.received",
          body: {
            phone: "+14155550123",
            message: "hostile body\u202e",
            deep_link: "/app/sms?tab=inbox",
          },
        }),
      ),
    ).toBe("/(tabs)/sms");
  });

  it("unwraps the JSON-stringified 'body' field that Expo uses for big payloads", () => {
    const inner = JSON.stringify({
      event_type: "subscriber.unsubscribed",
      body: { id: "sub-456" },
    });
    const out = routeForNotification(envelope({ body: inner }));
    expect(out).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "sub-456" },
    });
  });

  it("doesn't crash when 'body' is malformed JSON", () => {
    expect(
      routeForNotification(envelope({ body: "{not valid json" })),
    ).toBeNull();
  });

  it("ignores oversized JSON-stringified notification bodies", () => {
    const body = JSON.stringify({
      event_type: "subscriber.unsubscribed",
      body: { id: "sub-oversized", pad: "😊".repeat(9000) },
    });

    expect(routeForNotification(envelope({ body }))).toBeNull();
  });
});

describe("routeForAuthLink — address verification", () => {
  it("claims the verification link the AASA now hands over", () => {
    expect(
      routeForAuthLink("https://app.moosewave.com/verify-email?token=abc123"),
    ).toEqual({
      pathname: "/(auth)/verify-email",
      params: { token: "abc123" },
    });
    expect(routeForAuthLink("moosewave://auth/verify?token=abc123")).toEqual({
      pathname: "/(auth)/verify-email",
      params: { token: "abc123" },
    });
  });

  it("refuses a verification link with no token, so the screen never posts an empty body", () => {
    expect(
      routeForAuthLink("https://app.moosewave.com/verify-email"),
    ).toBeNull();
    expect(
      routeForAuthLink("https://app.moosewave.com/verify-email?token="),
    ).toBeNull();
  });

  it("refuses an absurdly long token rather than forwarding it to the limiter", () => {
    expect(
      routeForAuthLink(
        `https://app.moosewave.com/verify-email?token=${"a".repeat(513)}`,
      ),
    ).toBeNull();
  });

  it("does not accept a verification link from an untrusted host", () => {
    expect(
      routeForAuthLink("https://evil.example.com/verify-email?token=abc123"),
    ).toBeNull();
  });

  it("routes the verification link immediately, signed in or not", () => {
    const url = "https://app.moosewave.com/verify-email?token=abc123";
    for (const isAuthed of [true, false]) {
      expect(planDeepLinkNavigation(url, { isAuthed })).toEqual({
        kind: "navigate",
        target: {
          pathname: "/(auth)/verify-email",
          params: { token: "abc123" },
        },
      });
    }
  });
});

describe("routeForAuthLink", () => {
  it("returns null for empty / malformed urls", () => {
    expect(routeForAuthLink("")).toBeNull();
    expect(routeForAuthLink("not a url")).toBeNull();
  });

  it("routes magic-link tokens to /(auth)/magic-return", () => {
    const out = routeForAuthLink(
      signedAuthUrl("moosewave://auth/magic", "magic"),
    );
    expect(out).toEqual({
      pathname: "/(auth)/magic-return",
      params: expectedAuthParams("magic"),
    });
  });

  it("rejects every base_url link parameter, including otherwise valid self-hosted and localhost values", () => {
    const valid = signedAuthUrl("moosewave://auth/magic", "magic");
    for (const baseUrl of [
      "https://api.moosewave.com",
      "https://self-hosted.example.net/postwave",
      "http://localhost:8080",
      "javascript:alert(1)",
    ]) {
      expect(
        routeForAuthLink(valid + "&base_url=" + encodeURIComponent(baseUrl)),
      ).toBeNull();
    }
  });

  it("routes a signed browser-audience link to an explicit browser fallback state", () => {
    expect(
      routeForAuthLink(
        signedAuthUrl("https://app.moosewave.com/magic-link", "magic", {
          audience: "web",
        }),
      ),
    ).toEqual({
      pathname: "/(auth)/magic-return",
      params: expectedAuthParams("magic", "web"),
    });
  });

  it("rejects duplicate or incomplete v1 contract fields", () => {
    const valid = signedAuthUrl("moosewave://auth/magic", "magic");
    expect(routeForAuthLink(valid + "&v=1")).toBeNull();
    expect(routeForAuthLink(valid.replace("&sig=", "&sig=&other="))).toBeNull();
    expect(
      routeForAuthLink(valid.replace("flow=magic", "flow=reset")),
    ).toBeNull();
  });

  it("magic-link without a token or state is rejected", () => {
    expect(routeForAuthLink("moosewave://auth/magic")).toBeNull();
    expect(routeForAuthLink("moosewave://auth/magic?token=abc")).toBeNull();
    expect(routeForAuthLink("moosewave://auth/magic?state=nonce123")).toBeNull();
  });

  it("rejects oversized auth deep-link tokens and states", () => {
    expect(
      routeForAuthLink(
        `moosewave://auth/magic?token=${"a".repeat(3000)}&state=nonce123`,
      ),
    ).toBeNull();
    expect(
      routeForAuthLink(
        `moosewave://auth/magic?token=abc&state=${"a".repeat(300)}`,
      ),
    ).toBeNull();
    expect(
      routeForAuthLink(`moosewave://auth/reset?token=${"a".repeat(3000)}`),
    ).toBeNull();
  });

  it("routes production universal magic links to magic-return", () => {
    const out = routeForAuthLink(
      signedAuthUrl("https://app.moosewave.com/magic-link", "magic"),
    );
    expect(out).toEqual({
      pathname: "/(auth)/magic-return",
      params: expectedAuthParams("magic"),
    });
  });

  it("routes /auth/magic universal links to magic-return", () => {
    const out = routeForAuthLink(
      signedAuthUrl("https://app.moosewave.com/auth/magic", "magic"),
    );
    expect(out).toEqual({
      pathname: "/(auth)/magic-return",
      params: expectedAuthParams("magic"),
    });
  });

  it("rejects universal auth links from untrusted hosts", () => {
    expect(
      routeForAuthLink(
        signedAuthUrl("https://evil.example.com/auth/magic", "magic"),
      ),
    ).toBeNull();
  });

  it("rejects credential-bearing, fragmented, or non-exact auth URLs", () => {
    const valid = signedAuthUrl("moosewave://auth/magic", "magic");
    expect(routeForAuthLink(valid.replace("//auth", "//user@auth"))).toBeNull();
    expect(routeForAuthLink(valid + "#fragment")).toBeNull();
    expect(
      routeForAuthLink(
        signedAuthUrl("https://app.moosewave.com/magic-link/", "magic"),
      ),
    ).toBeNull();
  });

  it("routes password-reset deep links to reset-confirm", () => {
    expect(
      routeForAuthLink(signedAuthUrl("moosewave://auth/reset", "reset")),
    ).toEqual({
      pathname: "/(auth)/reset-confirm",
      params: expectedAuthParams("reset"),
    });
    expect(
      routeForAuthLink(
        signedAuthUrl("https://app.moosewave.com/reset-password", "reset"),
      ),
    ).toEqual({
      pathname: "/(auth)/reset-confirm",
      params: expectedAuthParams("reset"),
    });
  });

  it("routes the bare /auth query contract by its signed flow", () => {
    expect(
      routeForAuthLink(signedAuthUrl("https://app.moosewave.com/auth", "reset")),
    ).toEqual({
      pathname: "/(auth)/reset-confirm",
      params: expectedAuthParams("reset"),
    });
  });

  it("rejects reset links carrying any base_url", () => {
    expect(
      routeForAuthLink(
        signedAuthUrl("moosewave://auth/reset", "reset") +
          "&base_url=https%3A%2F%2Fself-hosted.example",
      ),
    ).toBeNull();
  });

  it("rejects password-reset links without a token", () => {
    expect(routeForAuthLink("moosewave://auth/reset")).toBeNull();
  });

  it("ignores non-auth URLs", () => {
    expect(routeForAuthLink("moosewave://subscribers/123")).toBeNull();
    expect(routeForAuthLink("https://app.moosewave.com/auth/magic")).toBeNull();
  });
});

describe("routeForEntityLink", () => {
  it("routes a campaign entity link to the campaign detail screen", () => {
    expect(routeForEntityLink("moosewave://campaign/cmp-123")).toEqual({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "cmp-123" },
    });
  });

  it("routes only canonical Helpdesk conversation identities", () => {
    expect(
      routeForEntityLink(
        `moosewave://helpdesk-conversation/${HELPDESK_CONVERSATION_ID}`,
      ),
    ).toEqual({
      pathname: "/(tabs)/helpdesk/[id]",
      params: { id: HELPDESK_CONVERSATION_ID },
    });
    expect(
      routeForEntityLink(
        `moosewave://helpdesk-ticket/${HELPDESK_CONVERSATION_ID}`,
      ),
    ).toBeNull();
    expect(
      routeForEntityLink("moosewave://helpdesk-conversation/ticket_123"),
    ).toBeNull();
    expect(
      routeForEntityLink(
        `https://app.moosewave.com/app/helpdesk/${HELPDESK_CONVERSATION_ID}`,
      ),
    ).toEqual({
      pathname: "/(tabs)/helpdesk/[id]",
      params: { id: HELPDESK_CONVERSATION_ID },
    });
  });

  it("routes a subscriber entity link to the subscriber detail screen", () => {
    expect(routeForEntityLink("moosewave://subscriber/sub-456")).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "sub-456" },
    });
  });

  it("routes a sequence entity link to the sequence detail screen", () => {
    expect(routeForEntityLink("moosewave://sequence/seq-789")).toEqual({
      pathname: "/(tabs)/sequences/[id]",
      params: { id: "seq-789" },
    });
  });

  it("routes canonical universal entity links to the matching mobile screen", () => {
    expect(
      routeForEntityLink("https://app.moosewave.com/app/campaigns/cmp-123"),
    ).toEqual({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "cmp-123" },
    });
    expect(
      routeForEntityLink("https://app.moosewave.com/app/subscribers/sub-456"),
    ).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "sub-456" },
    });
  });

  it("routes an approval entity link to the request's detail screen", () => {
    // `approval.mobileDetail` was `false` in @postwave/route-map long after
    // app/(tabs)/approvals/[id].tsx shipped, so the one link whose entire
    // purpose is "decide this on your phone" dropped the approver on a list.
    expect(routeForEntityLink("moosewave://approval/apr-1")).toEqual({
      pathname: "/(tabs)/approvals/[id]",
      params: { id: "apr-1" },
    });
  });

  it("still routes a detail-less entity to its list screen", () => {
    // The `mobileDetail: false` branch has no live entity today; migrations
    // exercise the same "land on the list" shape through the notification
    // grammar, so the behaviour stays covered rather than merely available.
    expect(
      routeForNotification(
        envelope({ event_type: "migration.completed", body: { id: "mig-1" } }),
      ),
    ).toBe("/(tabs)/migrations");
  });

  it("ignores auth deep links so they fall through to routeForAuthLink", () => {
    expect(routeForEntityLink("moosewave://auth/magic?token=abc123")).toBeNull();
    expect(routeForEntityLink("moosewave://auth/reset?token=abc")).toBeNull();
  });

  it("ignores unknown / malformed entity links", () => {
    expect(routeForEntityLink("")).toBeNull();
    expect(routeForEntityLink("not a url")).toBeNull();
    expect(routeForEntityLink("moosewave://unknown/123")).toBeNull();
    expect(routeForEntityLink("moosewave://campaign/../etc")).toBeNull();
    expect(
      routeForEntityLink("https://evil.example.com/app/campaigns/1"),
    ).toBeNull();
  });

  it("falls back to the mobile DESTINATION grammar for non-entity links", () => {
    // route-map declares four entities; mobile ships 40 more screens, and a
    // link naming one of them used to resolve to nothing at all — which is
    // also why a notification pointing at a list produced a dead tap.
    expect(routeForEntityLink("moosewave://dmarc")).toBe("/(tabs)/dmarc");
    expect(routeForEntityLink("https://app.moosewave.com/app/audit")).toBe(
      "/(tabs)/audit",
    );
  });

  it("keeps the destination fallback from widening the entity grammar", () => {
    // Still exactly two path segments on a trusted host, still no auth theft.
    expect(routeForEntityLink("moosewave://tags/42")).toBeNull();
    expect(routeForEntityLink("https://evil.example/app/audit")).toBeNull();
    expect(routeForEntityLink("moosewave://auth/magic?token=abc")).toBeNull();
  });
});

describe("planDeepLinkNavigation", () => {
  it("DEFERS a logged-out entity link instead of navigating (would be lost to the auth bounce)", () => {
    // This is the bug: when logged out, an entity deep link must NOT be
    // pushed immediately (the auth gate would bounce it to sign-in and the
    // target would silently vanish). It must be remembered for after auth.
    expect(
      planDeepLinkNavigation("moosewave://campaign/cmp-123", {
        isAuthed: false,
      }),
    ).toEqual({
      kind: "defer",
      target: { pathname: "/(tabs)/campaigns/[id]", params: { id: "cmp-123" } },
    });
  });

  it("NAVIGATES to an entity link immediately when the user is authenticated", () => {
    expect(
      planDeepLinkNavigation("moosewave://subscriber/sub-456", {
        isAuthed: true,
      }),
    ).toEqual({
      kind: "navigate",
      target: {
        pathname: "/(tabs)/subscribers/[id]",
        params: { id: "sub-456" },
      },
    });
  });

  it("navigates a deferred entity link to the SAME target the post-auth flush will use", () => {
    // The pending target stashed while logged out must equal the target an
    // authed user gets — otherwise the deferred navigation lands somewhere
    // different after sign-in.
    const deferred = planDeepLinkNavigation("moosewave://sequence/seq-789", {
      isAuthed: false,
    });
    const navigated = planDeepLinkNavigation("moosewave://sequence/seq-789", {
      isAuthed: true,
    });
    expect(deferred.kind).toBe("defer");
    expect(navigated.kind).toBe("navigate");
    expect(deferred.kind === "defer" ? deferred.target : null).toEqual(
      navigated.kind === "navigate" ? navigated.target : undefined,
    );
  });

  it("auth links take PRIORITY: magic-link navigates immediately even when logged out", () => {
    // Auth links are the sign-in flow itself — they must never be deferred.
    expect(
      planDeepLinkNavigation(signedAuthUrl("moosewave://auth/magic", "magic"), {
        isAuthed: false,
      }),
    ).toEqual({
      kind: "navigate",
      target: {
        pathname: "/(auth)/magic-return",
        params: expectedAuthParams("magic"),
      },
    });
  });

  it("reset links navigate immediately when logged out (not deferred)", () => {
    expect(
      planDeepLinkNavigation(signedAuthUrl("moosewave://auth/reset", "reset"), {
        isAuthed: false,
      }),
    ).toEqual({
      kind: "navigate",
      target: {
        pathname: "/(auth)/reset-confirm",
        params: expectedAuthParams("reset"),
      },
    });
  });

  it("ignores empty / unrecognised urls regardless of auth state", () => {
    expect(planDeepLinkNavigation(null, { isAuthed: false })).toEqual({
      kind: "ignore",
    });
    expect(planDeepLinkNavigation(undefined, { isAuthed: true })).toEqual({
      kind: "ignore",
    });
    expect(planDeepLinkNavigation("", { isAuthed: false })).toEqual({
      kind: "ignore",
    });
    expect(
      planDeepLinkNavigation("moosewave://unknown/123", { isAuthed: false }),
    ).toEqual({ kind: "ignore" });
    expect(planDeepLinkNavigation("not a url", { isAuthed: true })).toEqual({
      kind: "ignore",
    });
  });

  it("treats a DESTINATION link exactly like an entity link (navigate / defer)", () => {
    // A screen link needs a session just as much as a detail link does, so it
    // must be remembered across sign-in rather than bounced away.
    expect(
      planDeepLinkNavigation("moosewave://suppressions", { isAuthed: true }),
    ).toEqual({ kind: "navigate", target: "/(tabs)/suppressions" });
    expect(
      planDeepLinkNavigation("moosewave://suppressions", { isAuthed: false }),
    ).toEqual({ kind: "defer", target: "/(tabs)/suppressions" });
  });

  it("targets the push channel without inventing a separate route", () => {
    expect(
      planDeepLinkNavigation("moosewave://push-suppressions", {
        isAuthed: true,
      }),
    ).toEqual({
      kind: "navigate",
      target: "/(tabs)/suppressions?channel=push",
    });
    expect(
      planDeepLinkNavigation(
        "https://app.moosewave.com/app/push-suppressions?q=ignored%40example.test",
        { isAuthed: false },
      ),
    ).toEqual({
      kind: "defer",
      target:
        "/(tabs)/suppressions?channel=push&q=ignored%40example.test",
    });
  });

  it("navigates an approval entity link while authed and defers it when not", () => {
    const target = {
      pathname: "/(tabs)/approvals/[id]",
      params: { id: "apr-1" },
    };
    expect(
      planDeepLinkNavigation("moosewave://approval/apr-1", { isAuthed: true }),
    ).toEqual({ kind: "navigate", target });
    expect(
      planDeepLinkNavigation("moosewave://approval/apr-1", { isAuthed: false }),
    ).toEqual({ kind: "defer", target });
  });

  it("routes a device-approve universal link to cli-approve when authed", () => {
    expect(
      planDeepLinkNavigation(
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
        { isAuthed: true },
      ),
    ).toEqual({
      kind: "navigate",
      target: {
        pathname: "/(tabs)/cli-approve",
        params: { user_code: "ABCD-EFGH" },
      },
    });
  });

  it("DEFERS a logged-out device-approve link (approval needs a session)", () => {
    // Approving a new device requires being signed in on a trusted device, so
    // a logged-out approval link must wait for sign-in — same rule as entity
    // links, NOT the auth-link "route regardless" rule.
    const deferred = planDeepLinkNavigation(
      "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      { isAuthed: false },
    );
    expect(deferred).toEqual({
      kind: "defer",
      target: {
        pathname: "/(tabs)/cli-approve",
        params: { user_code: "ABCD-EFGH" },
      },
    });
    // And it's the SAME target the post-auth flush will navigate to.
    const navigated = planDeepLinkNavigation(
      "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      { isAuthed: true },
    );
    expect(deferred.kind === "defer" ? deferred.target : null).toEqual(
      navigated.kind === "navigate" ? navigated.target : undefined,
    );
  });

  it("ignores a device-approve link on an untrusted host or bad code", () => {
    expect(
      planDeepLinkNavigation(
        "https://evil.example/cli/auth?user_code=ABCD-EFGH",
        { isAuthed: true },
      ),
    ).toEqual({ kind: "ignore" });
    expect(
      planDeepLinkNavigation(
        "https://app.moosewave.com/cli/auth?user_code=bad",
        { isAuthed: true },
      ),
    ).toEqual({ kind: "ignore" });
  });
});

describe("routeForDeviceApproveLink", () => {
  it("maps only a canonical approval link to the cli-approve route", () => {
    expect(
      routeForDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toEqual({
      pathname: "/(tabs)/cli-approve",
      params: { user_code: "ABCD-EFGH" },
    });
    expect(
      routeForDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=abcd-efgh",
      ),
    ).toBeNull();
  });

  it("returns null for non-approval links (so the caller falls through)", () => {
    expect(routeForDeviceApproveLink("")).toBeNull();
    expect(
      routeForDeviceApproveLink("https://app.moosewave.com/app/campaigns/c1"),
    ).toBeNull();
    expect(
      routeForDeviceApproveLink("moosewave://cli/auth?user_code=ABCD-EFGH"),
    ).toBeNull();
  });
});
