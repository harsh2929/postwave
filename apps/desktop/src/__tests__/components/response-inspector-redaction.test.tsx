// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.copy,
  clipboardSuccessDetail: () => "The clipboard will clear automatically.",
}));

vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import {
  buildSafeCurl,
  type FireResponse,
  ResponseInspector,
  sanitizeInspectableText,
  sanitizeInspectableUrl,
} from "../../components/webhook-simulator/ResponseInspector";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.copy.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.copy.mockResolvedValue({ ok: true, method: "navigator" });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

const AWS_ACCESS_KEY_FIXTURE = "AKIA" + "IOSFODNN7EXAMPLE";

function response(): FireResponse {
  return {
    url: "https://hooks.example.test/ghp_path-token/receive?token=live-url-token&trace=trace-123",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": "request-123",
      "X-Postwave-Signature": "t=1700000000,v1=request-bound-signature",
      aUtHoRiZaTiOn: "Bearer live-bearer-token",
      CoOkIe: "session=live-cookie",
      "X-API-Key": "live-api-key",
      "X-Custom-Auth": "opaque-custom-credential",
      "X-Trace": "Bearer credential-hidden-by-value",
      "X-AuthToken": "opaque-camel-secret",
      "X-Prefixed": "prefix Bearer embedded-header-secret",
      "X-Tenant-ID": "[REDACTED]",
    },
    redacted_header_count: 5,
    body: {
      event: {
        type: "subscriber.created",
        access_token: "live-body-token",
        credential_hint: "Bearer live-body-bearer",
        note: `AWS key ${AWS_ACCESS_KEY_FIXTURE}`,
      },
    },
    signature: "t=1700000000,v1=request-bound-signature",
    requested_at: "2026-07-17T08:00:00.000Z",
    status_code: 202,
    response_body:
      '{"accepted":true,"authorization":"Bearer live-echoed-token","note":"ghp_echoed-token","echo_url":"https://receiver.test/callback?token=echoed-query-secret"}',
    latency_ms: 18,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

const SECRETS = [
  "live-url-token",
  "ghp_path-token",
  "live-bearer-token",
  "live-cookie",
  "live-api-key",
  "opaque-custom-credential",
  "credential-hidden-by-value",
  "opaque-camel-secret",
  "embedded-header-secret",
  "live-body-token",
  "live-body-bearer",
  AWS_ACCESS_KEY_FIXTURE,
  "live-echoed-token",
  "ghp_echoed-token",
  "echoed-query-secret",
];

describe("ResponseInspector credential redaction", () => {
  it("renders a filtered result as an explicit no-delivery outcome", async () => {
    const filtered: FireResponse = {
      url: "https://hooks.example.test/receive",
      method: "POST",
      headers: {},
      body: { event: { id: "evt_filtered", type: "subscriber.created" } },
      signature: "",
      requested_at: "2026-07-23T15:30:00.000Z",
      status_code: 204,
      response_body: "",
      latency_ms: 0,
      filtered: true,
    };

    render(<ResponseInspector response={filtered} />);

    expect(document.body.textContent).toContain("FILTERED");
    expect(document.body.textContent).toContain("Filtered before delivery");
    expect(document.body.textContent).toContain("made no receiver request");
    expect(document.body.textContent).toContain("evt_filtered");
    expect(document.body.textContent).not.toContain("Signature:");
    expect(document.body.textContent).not.toContain("Copy safe curl");
    expect(document.querySelector('[role="tablist"]')).toBeNull();

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("redacts before render and before the safe cURL reaches clipboard", async () => {
    render(<ResponseInspector response={response()} />);

    expect(document.body.textContent).toContain(
      "8 credential-bearing headers redacted",
    );
    expect(document.body.textContent).toContain(
      "2 sensitive URL details were also redacted",
    );
    expect(document.body.textContent).toContain("request-123");
    expect(document.body.textContent).toContain(
      "t=1700000000,v1=request-bound-signature",
    );
    for (const secret of SECRETS) {
      expect(document.body.textContent).not.toContain(secret);
    }

    act(() => button("curl").click());
    const copy = button("Copy safe curl");
    act(() => {
      copy.click();
      copy.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.copy).toHaveBeenCalledTimes(1);
    const copied = String(mocks.copy.mock.calls[0]?.[0]);
    expect(copied).toContain("[REDACTED]");
    expect(copied).toContain("X-Request-ID: request-123");
    expect(copied).toContain(
      "X-Postwave-Signature: REGENERATE_SIGNATURE_FOR_THE_EXACT_BODY",
    );
    expect(copied).toContain("https://YOUR_RECEIVER.example/postwave-webhook");
    expect(copied).not.toContain("hooks.example.test");
    expect(copied).not.toContain("request-bound-signature");
    for (const secret of SECRETS) expect(copied).not.toContain(secret);

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("defaults an unsafe method token and sanitizes without rendering", () => {
    const unsafe = response();
    unsafe.method = "POST; touch /tmp/owned";
    unsafe.url =
      "https://live-user:live-password@hooks.example.test/ghp_path-token/receive?token=live-url-token#access_token=live-fragment-token";
    const curl = buildSafeCurl(unsafe);

    expect(curl).toContain("curl -X POST ");
    expect(curl).toContain("https://YOUR_RECEIVER.example/postwave-webhook");
    expect(curl).not.toContain("touch /tmp/owned");
    expect(curl).not.toContain("live-user");
    expect(curl).not.toContain("live-password");
    expect(curl).not.toContain("live-fragment-token");
    for (const secret of SECRETS) expect(curl).not.toContain(secret);
  });

  it("redacts credential-bearing URLs embedded inside otherwise plain diagnostics", () => {
    const result = sanitizeInspectableText(
      "receiver failed at https://api.example.test/path?key=generic-secret&trace=trace-123",
    );

    expect(result.text).toContain("trace=trace-123");
    expect(result.text).toContain("key=%5BREDACTED%5D");
    expect(result.text).not.toContain("generic-secret");
    expect(result.redactedCount).toBe(1);
  });

  it("terminates malformed URL sanitization fail-closed without recursive re-entry", () => {
    expect(sanitizeInspectableUrl("https://%")).toEqual({
      url: "[REDACTED]",
      redactedCount: 1,
    });
    expect(
      sanitizeInspectableText("receiver returned malformed target https://%"),
    ).toEqual({
      text: "receiver returned malformed target [REDACTED]",
      redactedCount: 1,
    });
  });

  it("renders malformed URL tokens in receiver body and error as redacted", () => {
    const malformed = response();
    malformed.url = "https://hooks.example.test/receive";
    malformed.headers = {};
    malformed.body = { event: "subscriber.created" };
    malformed.signature = "";
    malformed.status_code = 503;
    malformed.response_body = "receiver echoed https://%";
    malformed.error = "transport rejected https://%";

    render(<ResponseInspector response={malformed} />);

    expect(document.body.textContent).toContain("receiver echoed [REDACTED]");
    expect(document.body.textContent).toContain(
      "transport rejected [REDACTED]",
    );
    expect(document.body.textContent).not.toContain("https://%");
  });
});
