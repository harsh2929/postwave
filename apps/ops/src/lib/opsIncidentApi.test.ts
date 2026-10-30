// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forwardIncidentOpen,
  forwardIncidentUpdate,
  isIncidentID,
  normalizeIncidentSuccess,
} from "./opsIncidentApi";
import { CSRF_HEADER, CSRF_VALUE } from "./opsSecurity";

const INCIDENT_ID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b1";
const INTENT_ID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b2";
const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;
const ENV = {
  NODE_ENV: "production",
  OPS_API_ORIGIN: "https://internal-api.postwave.example",
  OPS_API_ALLOWED_HOSTS: "internal-api.postwave.example",
  OPS_PUBLIC_ORIGIN: "https://ops.postwave.example",
  OPS_RUNBOOK_BASE_URL: "https://runbooks.postwave.example/production/",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function productionRequest(body: string, headers: Record<string, string> = {}): Request {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  return new Request("https://ops.postwave.example/api/incidents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `analytics=secret; pw_session=${SESSION}; private=secret`,
      origin: ENV.OPS_PUBLIC_ORIGIN,
      [CSRF_HEADER]: CSRF_VALUE,
      ...headers,
    },
    body,
  });
}

describe("isIncidentID", () => {
  it("accepts only canonical non-zero UUIDs", () => {
    expect(isIncidentID(INCIDENT_ID)).toBe(true);
    expect(isIncidentID(INCIDENT_ID.toUpperCase())).toBe(false);
    expect(isIncidentID("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
  it("rejects non-UUIDs and traversal", () => {
    expect(isIncidentID("../../x")).toBe(false);
    expect(isIncidentID("")).toBe(false);
    expect(isIncidentID("not-a-uuid")).toBe(false);
  });
});

describe("normalizeIncidentSuccess", () => {
  it("whitelists exact open/update outcomes", () => {
    expect(normalizeIncidentSuccess({ id: INCIDENT_ID, status: "open", replayed: true }, "open")).toEqual({
      id: INCIDENT_ID,
      status: "open",
      replayed: true,
    });
    expect(normalizeIncidentSuccess({ incident_id: INCIDENT_ID, status: "applied", replayed: false }, "update")).toEqual({
      incident_id: INCIDENT_ID,
      status: "applied",
      replayed: false,
    });
  });
  it("rejects malformed outcomes", () => {
    expect(normalizeIncidentSuccess({ id: INCIDENT_ID, status: "open", replayed: true, secret: "x" }, "open")).toBeUndefined();
    expect(normalizeIncidentSuccess({ id: "bad", status: "open", replayed: false }, "open")).toBeUndefined();
    expect(normalizeIncidentSuccess({ id: INCIDENT_ID, status: "open" }, "open")).toBeUndefined();
    expect(normalizeIncidentSuccess({ incident_id: INCIDENT_ID, status: "queued", replayed: false }, "update")).toBeUndefined();
  });
});

describe("incident proxy", () => {
  it("forwards only the session and preserves the payload-bound intent key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: INCIDENT_ID, status: "open", replayed: false }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const body = JSON.stringify({ title: "Outage", severity: "sev1", body: "Investigating", idempotency_key: INTENT_ID });
    const response = await forwardIncidentOpen(productionRequest(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: INCIDENT_ID, status: "open", replayed: false });

    const [, init] = fetchMock.mock.calls[0];
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("cookie")).toBe(`pw_session=${SESSION}`);
    expect(forwarded.get("x-postwave-ops-csrf")).toBe("same-origin");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual(JSON.parse(body));
  });

  it("rejects oversized bodies and invalid upstream media types", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const oversized = await forwardIncidentOpen(
      productionRequest("{}", { "content-length": String(21 * 1024) }),
    );
    expect(oversized.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }));
    const response = await forwardIncidentOpen(productionRequest(JSON.stringify({
      title: "Outage",
      severity: "sev1",
      body: "Investigating",
      idempotency_key: INTENT_ID,
    })));
    expect(response.status).toBe(502);
  });

  it("rejects invalid request fields and extra upstream response fields", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const badRequest = await forwardIncidentOpen(productionRequest(JSON.stringify({
      title: "Outage",
      severity: "sev0",
      body: "Investigating",
      idempotency_key: INTENT_ID,
    })));
    expect(badRequest.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: INCIDENT_ID,
      status: "open",
      replayed: false,
      internal: "must not be accepted",
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const invalidResponse = await forwardIncidentOpen(productionRequest(JSON.stringify({
      title: "Outage",
      severity: "sev1",
      body: "Investigating",
      idempotency_key: INTENT_ID,
    })));
    expect(invalidResponse.status).toBe(502);
  });
});

describe("forwardIncidentUpdate", () => {
  const updateBody = JSON.stringify({
    body: "scoping the blast radius",
    status: "resolved",
    idempotency_key: INTENT_ID,
  });

  it("rejects a non-uuid incident id before any upstream call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const badId = await forwardIncidentUpdate(productionRequest(updateBody), "not-a-uuid");
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({
      error: { code: "bad_incident_id", message: "that is not an incident id" },
    });

    const traversal = await forwardIncidentUpdate(productionRequest(updateBody), "../../etc/passwd");
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toEqual({
      error: { code: "bad_incident_id", message: "that is not an incident id" },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the update to the incident-scoped path and returns the applied outcome", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ incident_id: INCIDENT_ID, status: "applied", replayed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await forwardIncidentUpdate(productionRequest(updateBody), INCIDENT_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      incident_id: INCIDENT_ID,
      status: "applied",
      replayed: false,
    });

    expect(
      String(fetchMock.mock.calls[0][0]).endsWith(
        `/api/internal/ops/views/incidents/${INCIDENT_ID}/updates`,
      ),
    ).toBe(true);
  });

  it("accepts an empty status as a note-only update", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ incident_id: INCIDENT_ID, status: "applied", replayed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const noteOnly = JSON.stringify({
      body: "scoping the blast radius",
      status: "",
      idempotency_key: INTENT_ID,
    });
    const response = await forwardIncidentUpdate(productionRequest(noteOnly), INCIDENT_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      incident_id: INCIDENT_ID,
      status: "applied",
      replayed: true,
    });
  });

  it("rejects an upstream outcome whose status is not applied", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ incident_id: INCIDENT_ID, status: "open", replayed: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await forwardIncidentUpdate(productionRequest(updateBody), INCIDENT_ID);
    expect(response.status).toBe(502);
  });
});
