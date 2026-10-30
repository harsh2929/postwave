import { describe, expect, it } from "vitest";
import {
  EVENTS,
  TELEMETRY_CONSENT_DEFAULT,
  isKnownEvent,
  isSensitivePathSegment,
  isSensitiveQueryKey,
  redactBreadcrumb,
  redactEvent,
  redactPath,
  redactQueryString,
  redactUrl,
  shouldCapture,
} from "./index";

describe("redaction", () => {
  it("redacts sensitive query keys in a URL but leaves benign ones", () => {
    // URLSearchParams percent-encodes the marker (%5Bredacted%5D); what
    // matters is the secret value is gone and a benign param is untouched.
    const out = redactUrl("https://x/y?token=abc&page=2");
    expect(out).not.toContain("abc");
    expect(out.toLowerCase()).toContain("redacted");
    expect(out).toContain("page=2");
    expect(redactUrl("https://x/y?page=2")).toBe("https://x/y?page=2");
  });

  it("flags secret/auth/email-ish keys, not arbitrary ones", () => {
    expect(isSensitiveQueryKey("api_key")).toBe(true);
    expect(isSensitiveQueryKey("authorization")).toBe(true);
    expect(isSensitiveQueryKey("cursor")).toBe(true);
    expect(isSensitiveQueryKey("recipient_email")).toBe(true);
    expect(isSensitiveQueryKey("q")).toBe(true);
    expect(isSensitiveQueryKey("sequence")).toBe(false);
    expect(isSensitiveQueryKey("page")).toBe(false);
  });

  it("strips sensitive headers case-insensitively + clears body/cookies", () => {
    const ev = redactEvent({
      request: {
        data: { secret: 1 },
        cookies: "sid=1",
        headers: {
          authorization: "Bearer x",
          "X-Postwave-Token": "t",
          Accept: "json",
        },
        url: "https://x/y?session=s",
      },
    });
    expect(ev.request?.data).toBeUndefined();
    expect(ev.request?.cookies).toBeUndefined();
    expect(ev.request?.headers).toEqual({ Accept: "json" }); // lower + mixed case both stripped
    expect(String(ev.request?.url)).not.toContain("session=s");
    expect(String(ev.request?.url).toLowerCase()).toContain("redacted");
  });

  it("redacts breadcrumb url/to/from (the field web+mobile were missing)", () => {
    const c = redactBreadcrumb({
      data: { url: "https://x/y?api_key=k", method: "GET" },
    });
    expect(String(c.data?.url)).not.toContain("api_key=k");
    expect(String(c.data?.url).toLowerCase()).toContain("redacted");
    expect(c.data?.method).toBe("GET");
  });

  it("never throws on malformed URLs — returns input unchanged", () => {
    expect(redactUrl("not a url")).toBe("not a url");
  });

  // Regression: redactUrl/redactQueryString only scrubbed QUERY params, so a
  // token or email embedded in a PATH segment leaked verbatim into Sentry.
  it("scrubs secret/PII PATH segments in an absolute URL", () => {
    const token = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"; // 32-char hex token
    const out = redactUrl(`https://x/reset/${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("/reset/");
    expect(out).toContain("[redacted]");
  });

  it("scrubs an email in a path segment but keeps route words", () => {
    const out = redactUrl("https://x/subscribers/alice@example.com/profile");
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("/subscribers/");
    expect(out).toContain("/profile");
    expect(out).toContain("[redacted]");
  });

  it("keeps numeric ids and ordinary route words in paths", () => {
    expect(redactUrl("https://x/subscribers/42/edit")).toBe(
      "https://x/subscribers/42/edit",
    );
  });

  it("scrubs path segments on a bare path with a query string too", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM";
    const out = redactUrl(`/verify/${jwt}?next=%2Fapp`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("/verify/");
    expect(out).toContain("next=%2Fapp");
    expect(out).toContain("[redacted]");
  });

  it("always scrubs the public preference capability segment", () => {
    const shortCapability = "recipient-capability";
    expect(
      redactUrl(
        `https://api.moosewave.com/api/public/preferences/${shortCapability}/one-click?keep=value`,
      ),
    ).toBe(
      "https://api.moosewave.com/api/public/preferences/[redacted]/one-click?keep=value",
    );
    expect(redactUrl("https://api.moosewave.com/api/public/preferences/")).toBe(
      "https://api.moosewave.com/api/public/preferences/",
    );
    expect(redactPath(`/en/preferences/${shortCapability}/frequency`)).toBe(
      "/en/preferences/[redacted]/frequency",
    );
    expect(redactPath(`/preferences/${shortCapability}`)).toBe(
      "/preferences/[redacted]",
    );
  });

  it("redactPath scrubs UUID + token segments, leaves words", () => {
    expect(redactPath("/orders/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f")).toBe(
      "/orders/[redacted]",
    );
    expect(redactPath("/app/settings")).toBe("/app/settings");
  });

  it("scrubs short E.164 identifiers only in SMS route and API path shapes", () => {
    const phone = "+15551234567";
    expect(redactPath(`/sms/${phone}`)).toBe("/sms/[redacted]");
    expect(redactPath(`/sms/${encodeURIComponent(phone)}`)).toBe("/sms/[redacted]");
    expect(redactPath(`/api/v1/sms/conversations/${encodeURIComponent(phone)}/messages`)).toBe(
      "/api/v1/sms/conversations/[redacted]/messages",
    );
    expect(redactPath(`/app/sms-inbox/${phone}`)).toBe("/app/sms-inbox/[redacted]");
    expect(redactPath(`/app/sms-inbox/${encodeURIComponent(phone)}`)).toBe(
      "/app/sms-inbox/[redacted]",
    );
    expect(redactPath(`/contacts/${phone}`)).toBe(`/contacts/${phone}`);
  });

  it("redacts free-form inbox search in absolute and bare URLs", () => {
    const phone = "+15551234567";
    expect(redactUrl(`https://postwave.test/app/sms-inbox/${phone}?q=private%20reply`)).toBe(
      "https://postwave.test/app/sms-inbox/[redacted]?q=%5Bredacted%5D",
    );
    expect(redactUrl(`/app/sms-inbox/${encodeURIComponent(phone)}?q=reader@example.com#inbox`)).toBe(
      "/app/sms-inbox/[redacted]?q=%5Bredacted%5D#inbox",
    );
    expect(redactUrl("/app/sms-inbox?q=freeform%20body")).toBe(
      "/app/sms-inbox?q=%5Bredacted%5D",
    );
  });

  it("removes SMS phone and body from crash URLs, payloads, and breadcrumbs", () => {
    const phone = "+15551234567";
    const body = "private customer reply";
    const event = redactEvent({
      request: {
        url: `https://api.moosewave.com/api/v1/sms/conversations/${encodeURIComponent(phone)}/reply`,
        data: { body, phone },
      },
      extra: { body, phone },
      breadcrumbs: [
        { data: { to: `/sms/${encodeURIComponent(phone)}`, body } },
      ],
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain(encodeURIComponent(phone));
    expect(serialized).not.toContain(body);
    expect(event.request?.url).toBe(
      "https://api.moosewave.com/api/v1/sms/conversations/[redacted]/reply",
    );
    expect(event.breadcrumbs?.[0]?.data?.to).toBe("/sms/[redacted]");
  });

  it("isSensitivePathSegment flags secrets/emails, not route words", () => {
    expect(isSensitivePathSegment("alice@example.com")).toBe(true);
    expect(isSensitivePathSegment("9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f")).toBe(
      true,
    );
    expect(isSensitivePathSegment("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe(
      true,
    );
    expect(isSensitivePathSegment("subscribers")).toBe(false);
    expect(isSensitivePathSegment("42")).toBe(false);
    expect(isSensitivePathSegment("edit")).toBe(false);
  });

  it("redactBreadcrumb now also scrubs path-embedded secrets", () => {
    const token = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const c = redactBreadcrumb({ data: { url: `https://x/reset/${token}` } });
    expect(String(c.data?.url)).not.toContain(token);
    expect(String(c.data?.url)).toContain("[redacted]");
  });
});

describe("consent", () => {
  it("defaults to denied (opt-in model)", () => {
    expect(TELEMETRY_CONSENT_DEFAULT).toBe("denied");
    expect(shouldCapture(TELEMETRY_CONSENT_DEFAULT)).toBe(false);
  });
  it("captures only on explicit grant", () => {
    expect(shouldCapture("granted")).toBe(true);
    expect(shouldCapture("unset")).toBe(false);
    expect(shouldCapture(null)).toBe(false);
  });
});

describe("event taxonomy", () => {
  it("recognizes canonical names, rejects ad-hoc ones", () => {
    expect(isKnownEvent(EVENTS.CAMPAIGN_SENT)).toBe(true);
    expect(isKnownEvent("Campaign Sent!!")).toBe(false);
  });
  it("uses dot-namespaced names", () => {
    for (const name of Object.values(EVENTS))
      expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
  });
});

describe("query values are redacted by SHAPE, not only by parameter name", () => {
  // The key rule is a deny-list and cannot be completed. These two parameters
  // carried subscriber and teammate emails to Sentry verbatim: neither name
  // contains a listed part, and neither is the exact key "q". The product
  // promises on its own Privacy screen that no subscriber data is ever sent.
  it("redacts an email on the list-members search parameter", () => {
    const out = redactUrl(
      "https://api.moosewave.com/api/v1/lists/9f1e6b2c-1111-2222-3333-444455556666/subscribers?page=1&query=jane.doe%40acme.com",
    );
    expect(out).not.toContain("jane.doe");
    expect(out).toContain("page=1");
  });

  it("redacts an email on the audit actor filter", () => {
    const out = redactUrl(
      "https://api.moosewave.com/api/v1/audit?limit=100&actor_label=ops%40customer.com",
    );
    expect(out).not.toContain("ops%40customer.com");
    expect(out).not.toContain("ops@customer.com");
  });

  it("redacts a phone number whatever the parameter is called", () => {
    const out = redactUrl("https://api.moosewave.com/api/v1/sms?to=%2B14155550123");
    expect(out).not.toContain("14155550123");
  });

  it("leaves ordinary structural parameters alone", () => {
    const out = redactUrl(
      "https://api.moosewave.com/api/v1/campaigns?page=2&per_page=25&sort=newest",
    );
    expect(out).toContain("page=2");
    expect(out).toContain("per_page=25");
    expect(out).toContain("sort=newest");
  });

  it("applies through the bare-path helper as well", () => {
    expect(redactQueryString("query=jane%40acme.com&page=1")).not.toContain(
      "jane",
    );
  });
});
