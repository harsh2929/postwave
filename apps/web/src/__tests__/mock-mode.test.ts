// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { isMockModeEnabled } from "@/lib/mock-mode";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("mock mode", () => {
  it("is available only outside production", () => {
    vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
    vi.stubEnv("NODE_ENV", "development");
    expect(isMockModeEnabled()).toBe(true);

    vi.stubEnv("NODE_ENV", "production");
    expect(isMockModeEnabled()).toBe(false);
  });

  it("lets a pre-navigation browser test use intercepted APIs in dev", () => {
    vi.stubEnv("NEXT_PUBLIC_USE_MOCKS", "1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubGlobal("window", {
      __POSTWAVE_FORCE_REAL_API_FOR_E2E__: true,
    });

    expect(isMockModeEnabled()).toBe(false);
  });
});
