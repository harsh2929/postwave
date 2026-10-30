/**
 * The toggle at the transport seam: given the {data,error} envelope
 * `rawRequest` really resolves to, does the PATCH go out with the verb, the
 * encoded path, and the preserve echo — and does a failure become a throw the
 * screen can read a status off?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboundRoute } from "@/lib/inboundRoutes";

import {
  InboundRouteRequestError,
  setInboundRouteEnabled,
} from "./inboundRoutes";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

const route: InboundRoute = {
  id: "ab/12",
  name: "Bounces",
  priority: 7,
  stopOnMatch: false,
  enabled: true,
  matchRecipient: "",
  matchSubjectPrefix: "Re:",
  matchFromDomain: "bounce.example",
  actions: [{ kind: "tag", tag: "bounced", eventType: "", url: "", to: "" }],
  rawActions: [{ kind: "tag", tag: "bounced", extra: { color: "red" } }],
  lastMatchedAt: "",
  matchCount: 0,
  actionRetryMax: 0,
};

describe("setInboundRouteEnabled", () => {
  it("PATCHes the encoded id with the toggle AND the preserve echo", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await setInboundRouteEnabled(route, false);
    expect(rawRequest).toHaveBeenCalledTimes(1);
    const [method, path, body] = rawRequest.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(method).toBe("PATCH");
    expect(path).toBe("/api/v1/inbound-routes/ab%2F12");
    expect(body).toEqual({
      enabled: false,
      priority: 7,
      match_subject_prefix: "Re:",
      match_from_domain: "bounce.example",
      // Raw echo incl. `extra` — omission would write JSON null server-side.
      actions: [{ kind: "tag", tag: "bounced", extra: { color: "red" } }],
    });
  });

  it("surfaces the envelope's error as a typed throw carrying the status", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "admin scope required" },
    });
    await expect(setInboundRouteEnabled(route, false)).rejects.toMatchObject({
      name: "InboundRouteRequestError",
      status: 403,
      message: "admin scope required",
    });
  });

  it("refuses a blank id before any request leaves the phone", async () => {
    await expect(
      setInboundRouteEnabled({ ...route, id: "  " }, false),
    ).rejects.toThrow(/rule id/i);
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("a 403 is distinguishable from a generic failure", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    const err = await setInboundRouteEnabled(route, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboundRouteRequestError);
    expect((err as InboundRouteRequestError).status).toBe(403);
  });
});
