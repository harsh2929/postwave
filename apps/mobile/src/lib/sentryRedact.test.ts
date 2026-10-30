import { describe, expect, it } from "vitest";

import {
  redactBreadcrumb,
  redactEvent,
  type RedactableEvent,
} from "./sentryRedact";

describe("redactEvent", () => {
  it("drops request body and cookies entirely", () => {
    const ev: RedactableEvent = {
      request: { data: { password: "hunter2" }, cookies: { pw_session: "x" } },
    };
    const out = redactEvent(ev);
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
  });

  it("strips Authorization, Cookie and X-Postwave-Token headers", () => {
    const ev: RedactableEvent = {
      request: {
        headers: {
          Authorization: "Bearer secret",
          Cookie: "pw_session=abc",
          "X-Postwave-Token": "tok",
          "Content-Type": "application/json",
          "X-Customer-Debug": "reader@example.com",
        },
      },
    };
    const out = redactEvent(ev);
    expect(out.request?.headers?.Authorization).toBeUndefined();
    expect(out.request?.headers?.Cookie).toBeUndefined();
    expect(out.request?.headers?.["X-Postwave-Token"]).toBeUndefined();
    // non-sensitive headers are preserved
    expect(out.request?.headers?.["Content-Type"]).toBe("application/json");
    expect(out.request?.headers?.["X-Customer-Debug"]).toBeUndefined();
  });

  it("redacts sensitive query-string params but keeps benign ones", () => {
    const ev: RedactableEvent = {
      request: {
        query_string: "page=2&api_key=abc123&email=a@b.com&token=zzz",
      },
    };
    const out = redactEvent(ev);
    const qs = out.request?.query_string as string;
    expect(qs).toContain("page=2");
    expect(qs).not.toContain("abc123");
    expect(qs).not.toContain("a%40b.com");
    expect(qs).not.toContain("zzz");
    expect(qs).toContain("api_key=%5Bredacted%5D");
  });

  it("redacts sensitive params inside a full request URL", () => {
    const ev: RedactableEvent = {
      request: {
        url: "https://api.moosewave.com/v1/x?subscriber=a@b.com&keep=1&session=deadbeef",
      },
    };
    const out = redactEvent(ev);
    const url = out.request?.url as string;
    expect(url).toContain("keep=1");
    expect(url).not.toContain("a%40b.com");
    expect(url).not.toContain("deadbeef");
    expect(url).toContain("https://api.moosewave.com/v1/x");
  });

  it("is a no-op (no throw) when there is no request", () => {
    const ev: RedactableEvent = {};
    expect(() => redactEvent(ev)).not.toThrow();
    expect(redactEvent(ev)).toEqual({});
  });

  it("leaves a malformed query string untouched rather than throwing", () => {
    const ev: RedactableEvent = { request: { query_string: "%%%notvalid" } };
    expect(() => redactEvent(ev)).not.toThrow();
  });

  it("removes seeded PII and secrets from every unbounded Sentry field", () => {
    const secret = "reader@example.com secret-customer-subject";
    const ev: RedactableEvent = {
      message: secret,
      user: { email: secret },
      contexts: { customer: { name: secret } },
      extra: { response: secret },
      fingerprint: [secret],
      logentry: { message: secret, formatted: secret, params: [secret] },
      exception: { values: [{ type: "ApiError", value: secret }] },
      tags: {
        operation: "auth.magic_link",
        customer_name: secret,
        status: secret,
      },
      breadcrumbs: [
        {
          message: secret,
          data: {
            url: `https://api.moosewave.com/reset?token=${secret}`,
            response_body: secret,
            method: "POST",
          },
        },
      ],
    };

    const serialized = JSON.stringify(redactEvent(ev));
    expect(serialized).not.toContain("reader@example.com");
    expect(serialized).not.toContain("secret-customer-subject");
    expect(ev.exception?.values?.[0]?.value).toBe("[redacted message]");
    expect(ev.tags).toEqual({ operation: "auth.magic_link" });
    expect(ev.breadcrumbs?.[0]?.data).toMatchObject({ method: "POST" });
  });
});

describe("redactBreadcrumb", () => {
  it("drops arbitrary messages and data while retaining safe diagnostics", () => {
    const crumb = redactBreadcrumb({
      message: "customer reader@example.com failed",
      data: {
        url: "https://api.moosewave.com/x?api_key=secret&keep=1",
        method: "GET",
        status_code: 503,
        response: "private upstream body",
      },
    });

    expect(crumb.message).toBeUndefined();
    expect(crumb.data).toEqual({
      url: "https://api.moosewave.com/x?api_key=%5Bredacted%5D&keep=1",
      method: "GET",
      status_code: 503,
    });
  });
});
