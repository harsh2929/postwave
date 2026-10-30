/**
 * The projected off switch at the transport seam: given the {data,error}
 * envelope `rawRequest` really resolves to, does the PATCH leave with the
 * verb, the encoded path and the both-revisions-safe body — and does a
 * refusal become a typed throw the rollback sentence can read a status off?
 *
 * Mocked-hook render tests and the node policy test both inject a fake
 * `patch`, so this is the only place the real transport is exercised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboundRoute } from "@/lib/inboundRoutes";

import { patchInboundRouteEnabled } from "./inboundRouteEnabled";
import { InboundRouteRequestError } from "./inboundRoutes";

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

describe("patchInboundRouteEnabled", () => {
  it("PATCHes the encoded id with the toggle, the preserve echo, and actions: []", async () => {
    // 204 No Content: the envelope carries no data and no error.
    rawRequest.mockResolvedValue({ data: null, error: null });
    await expect(patchInboundRouteEnabled(route, false)).resolves.toBeUndefined();
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
      // Empty even though the route HAS actions on the wire: the preserve
      // arm of both handler revisions, with no CAS token to fail.
      actions: [],
    });
  });

  it("switches back on with the same body shape", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await patchInboundRouteEnabled({ ...route, enabled: false }, true);
    const [, , body] = rawRequest.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(body).toMatchObject({ enabled: true, actions: [] });
  });

  it("surfaces the envelope's error as a typed throw carrying status and code", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 409, code: "route_changed", message: "route configuration changed" },
    });
    const err = await patchInboundRouteEnabled(route, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboundRouteRequestError);
    expect(err).toMatchObject({
      name: "InboundRouteRequestError",
      status: 409,
      code: "route_changed",
      message: "route configuration changed",
    });
  });

  it("a 403 is distinguishable from a generic failure", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "admin scope required" },
    });
    const err = await patchInboundRouteEnabled(route, true).catch((e: unknown) => e);
    expect((err as InboundRouteRequestError).status).toBe(403);
    expect((err as Error).message).toBe("admin scope required");
  });

  it("falls back to the direction's own sentence when the server sent none", async () => {
    rawRequest.mockResolvedValue({ data: null, error: { status: 500, message: "" } });
    await expect(patchInboundRouteEnabled(route, false)).rejects.toThrow(
      "Switching the rule off",
    );
  });

  it("refuses a blank id before any request leaves the phone", async () => {
    await expect(
      patchInboundRouteEnabled({ ...route, id: "  " }, false),
    ).rejects.toThrow(/rule id/i);
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
