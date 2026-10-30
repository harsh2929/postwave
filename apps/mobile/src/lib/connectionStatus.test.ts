import { describe, expect, it } from "vitest";

import {
  connectionStatus,
  shouldShowConnectionIndicator,
} from "@/lib/connectionStatus";

describe("connectionStatus", () => {
  it("reports a validated session as healthy", () => {
    const status = connectionStatus({
      mode: "session",
      sessionValidation: "validated_online",
    });
    expect(status).toMatchObject({
      label: "Session",
      tone: "success",
      healthy: true,
    });
    expect(shouldShowConnectionIndicator(status)).toBe(false);
  });

  it("reports an offline-cached session as an unhealthy warning", () => {
    const status = connectionStatus({
      mode: "session",
      sessionValidation: "offline_cached",
    });
    expect(status.healthy).toBe(false);
    expect(status.tone).toBe("warning");
    // The spoken form must explain the consequence, not just name a colour.
    expect(status.spoken).toContain("cached");
    expect(shouldShowConnectionIndicator(status)).toBe(true);
  });

  it("treats a session that has not yet been validated as still checking", () => {
    // Cold start: hydrate() restores the profile before the first
    // revalidation is scheduled. Flashing "Offline" there would be a lie.
    expect(
      connectionStatus({ mode: "session", sessionValidation: "none" }).label,
    ).toBe("Checking");
    expect(
      connectionStatus({ mode: "session", sessionValidation: "checking" })
        .healthy,
    ).toBe(false);
  });

  it("treats api-key mode as healthy regardless of session validation", () => {
    const status = connectionStatus({
      mode: "api_key",
      sessionValidation: "none",
    });
    expect(status).toMatchObject({ label: "API key", healthy: true });
    expect(shouldShowConnectionIndicator(status)).toBe(false);
  });

  it("renders nothing extra when signed out — OfflineBanner owns that state", () => {
    const status = connectionStatus({
      mode: null,
      sessionValidation: "none",
    });
    expect(status.label).toBe("Offline");
    expect(shouldShowConnectionIndicator(status)).toBe(false);
  });

  it("never returns an empty spoken string", () => {
    const modes = ["session", "api_key", null] as const;
    const validations = [
      "none",
      "checking",
      "validated_online",
      "offline_cached",
    ] as const;
    for (const mode of modes) {
      for (const sessionValidation of validations) {
        const status = connectionStatus({ mode, sessionValidation });
        expect(status.spoken.length).toBeGreaterThan(0);
        expect(status.label.length).toBeGreaterThan(0);
      }
    }
  });
});
