import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeHelpLauncher,
  getHelpLauncherState,
  requestContextualHelpOpen,
  requestHelpLauncherToggle,
  resetHelpLauncherForTests,
  subscribeHelpLauncherToggle,
} from "../../lib/help-launcher";

afterEach(() => resetHelpLauncherForTests());

describe("help launcher state", () => {
  it("retains only a sanitized contextual request until handoff closes", () => {
    requestContextualHelpOpen({
      task: "recovery",
      errorCode: "SAVE_FAILED",
      incidentId: "PW-20260716-A1B2C3D4E5",
      ...({ secret: "pw_live_private" } as object),
    });

    expect(getHelpLauncherState()).toMatchObject({
      open: true,
      destination: "dashboard",
      request: {
        task: "recovery",
        errorCode: "SAVE_FAILED",
        incidentId: "PW-20260716-A1B2C3D4E5",
      },
    });
    expect(JSON.stringify(getHelpLauncherState())).not.toContain("pw_live");

    closeHelpLauncher();
    expect(getHelpLauncherState()).toMatchObject({
      open: false,
      request: {},
      destination: null,
    });
  });

  it("toggles from the semantic shortcut and notifies subscribers once", () => {
    const subscriber = vi.fn();
    const dispose = subscribeHelpLauncherToggle(subscriber);

    requestHelpLauncherToggle();
    expect(getHelpLauncherState().open).toBe(true);
    requestHelpLauncherToggle();
    expect(getHelpLauncherState().open).toBe(false);
    expect(subscriber).toHaveBeenCalledTimes(2);

    dispose();
    requestHelpLauncherToggle();
    expect(subscriber).toHaveBeenCalledTimes(2);
  });
});
