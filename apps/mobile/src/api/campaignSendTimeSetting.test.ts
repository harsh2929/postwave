/**
 * The workspace send-time default: GET and PUT on the settings route, the
 * PUT body carrying `enabled` EXPLICITLY — the server decodes a pointer, so
 * an absent field would silently change nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSendTimeOptimizationSetting,
  putSendTimeOptimizationSetting,
} from "./campaignSendTimeSetting";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: { enabled: true }, error: null });
});

describe("send-time default transport", () => {
  it("GET /api/v1/settings/send-time-optimization", async () => {
    await getSendTimeOptimizationSetting();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/settings/send-time-optimization",
    );
  });
  it("PUT carries {enabled} explicitly, false included", async () => {
    await putSendTimeOptimizationSetting(false);
    expect(rawRequest).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/settings/send-time-optimization",
      { enabled: false },
    );
  });
});
