/**
 * `tracesSampleRate` is set on this SDK, so it is configured to send a second
 * envelope kind the error hooks never see: transactions.
 *
 * The security review recorded this as dormant — no tracing integration is
 * registered, so no spans are produced today. Dormant is a statement about
 * volume, not about content. The moment someone adds
 * `reactNavigationIntegration()` or turns on fetch instrumentation, spans
 * begin flowing through a configuration written without a scrubber, carrying
 * the request URL in each span's `description` and `data` — and this app puts
 * subscriber identity in the PATH (/subscribers/<email>, /sms/<phoneE164>).
 *
 * These tests drive the REAL hooks off the real init options, not a copy of
 * the redaction logic, so they fail if the hooks are removed from the config
 * as well as if the redaction stops working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();

vi.mock("@sentry/react-native", () => ({
  init,
  wrap: <T,>(component: T): T => component,
  captureException: vi.fn(),
}));

type CapturedOptions = Record<string, unknown> & {
  beforeSendTransaction?: (event: unknown) => unknown;
  beforeSendSpan?: (span: unknown) => unknown;
};

async function initWithDsn(): Promise<CapturedOptions> {
  vi.resetModules();
  init.mockClear();
  process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = "https://key@example.invalid/1";
  process.env.EXPO_PUBLIC_POSTWAVE_ENV = "test";
  const { initSentry } = await import("./sentry");
  // Consent is now read before the SDK starts, so init is async and takes the
  // reader; these tests supply a granted decision (optOut === false).
  await initSentry(async () => false);
  return init.mock.calls[0]?.[0] as CapturedOptions;
}

const savedDsn = process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE;
const savedEnv = process.env.EXPO_PUBLIC_POSTWAVE_ENV;

beforeEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
});

afterEach(() => {
  if (savedDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE;
  else process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = savedDsn;
  if (savedEnv === undefined) delete process.env.EXPO_PUBLIC_POSTWAVE_ENV;
  else process.env.EXPO_PUBLIC_POSTWAVE_ENV = savedEnv;
});

describe("the transaction envelope is scrubbed", () => {
  it("wires a hook for every envelope kind tracing can produce", async () => {
    const options = await initWithDsn();

    // A sampled rate with no hook is the configuration this test exists to
    // prevent, so assert the rate is really on rather than passing vacuously.
    expect(options.tracesSampleRate).toBeTypeOf("number");
    expect(typeof options.beforeSendTransaction).toBe("function");
    expect(typeof options.beforeSendSpan).toBe("function");
  });

  it("redacts the subscriber email out of a span's URL and data bag", async () => {
    const options = await initWithDsn();

    const span = options.beforeSendSpan?.({
      op: "http.client",
      description: "GET https://api.example.invalid/subscribers/ada@example.com",
      data: {
        "http.request.method": "GET",
        "http.url": "https://api.example.invalid/subscribers/ada@example.com",
        "http.response.status_code": 200,
      },
    }) as { description: string; data: Record<string, unknown> };

    expect(span.description).not.toContain("ada@example.com");
    expect(JSON.stringify(span.data)).not.toContain("ada@example.com");
    // The structural half must survive — a scrubber that empties the span
    // makes tracing useless and would be "fixed" by removing the hook.
    expect(span.description).toContain("GET");
    expect(span.data["http.response.status_code"]).toBe(200);
  });

  it("drops a data key no integration has been reviewed for", async () => {
    const options = await initWithDsn();

    const span = options.beforeSendSpan?.({
      op: "http.client",
      data: { "some.future.integration.body": "ada@example.com" },
    }) as { data: Record<string, unknown> };

    // Allowlist, not denylist: an integration added later cannot ship a new
    // field by default just because nobody thought to ban it.
    expect(span.data["some.future.integration.body"]).toBeUndefined();
  });

  it("redacts the phone number out of a transaction name", async () => {
    const options = await initWithDsn();

    const event = options.beforeSendTransaction?.({
      type: "transaction",
      transaction: "/sms/+15551234567",
      contexts: { trace: { trace_id: "abc", span_id: "def", op: "navigation" } },
      spans: [
        {
          op: "http.client",
          description: "POST https://api.example.invalid/sms/+15551234567",
        },
      ],
    }) as {
      transaction: string;
      contexts: { trace: Record<string, unknown> };
      spans: { description: string }[];
    };

    expect(event.transaction).not.toContain("15551234567");
    expect(event.spans[0]?.description).not.toContain("15551234567");
  });

  it("keeps the trace context a transaction needs to be ingested at all", async () => {
    const options = await initWithDsn();

    const event = options.beforeSendTransaction?.({
      type: "transaction",
      transaction: "/dashboard",
      contexts: {
        trace: {
          trace_id: "0123456789abcdef",
          span_id: "fedcba98",
          op: "navigation",
          // The http integration puts the request URL in here too.
          data: { url: "https://api.example.invalid/subscribers/ada@example.com" },
        },
      },
    }) as { contexts?: { trace?: Record<string, unknown> } };

    // redactEvent deletes `contexts` outright, which is right for an error and
    // fatal for a transaction: Sentry drops a transaction with no trace_id at
    // ingest, so a scrubber that removed it would look like it worked while
    // silently discarding every transaction.
    expect(event.contexts?.trace?.trace_id).toBe("0123456789abcdef");
    expect(event.contexts?.trace?.span_id).toBe("fedcba98");
    // ...but the unbounded bag inside it still goes.
    expect(event.contexts?.trace?.data).toBeUndefined();
  });
});
