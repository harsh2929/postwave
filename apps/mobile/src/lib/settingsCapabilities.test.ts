import { describe, expect, it } from "vitest";

import { settingsCapabilities } from "./settingsCapabilities";

const WORKSPACE_KEYS = [
  "canManageWorkspace",
  "canManageNotifications",
  "canManageRetention",
  "canManageWebhooks",
  "canManageVoiceLabels",
  "canManagePrivacy",
] as const;

describe("settingsCapabilities", () => {
  it("grants every control to an owner", () => {
    const caps = settingsCapabilities("owner", "session");
    for (const key of WORKSPACE_KEYS) expect(caps[key], key).toBe(true);
    expect(caps.canManageApprovalGovernance).toBe(true);
    expect(caps.hasRestrictedWorkspaceControls).toBe(false);
  });

  it("grants every control to an admin", () => {
    const caps = settingsCapabilities("admin", "session");
    for (const key of WORKSPACE_KEYS) expect(caps[key], key).toBe(true);
    expect(caps.canManageApprovalGovernance).toBe(true);
    expect(caps.hasRestrictedWorkspaceControls).toBe(false);
  });

  it("withholds every workspace control from an editor", () => {
    const caps = settingsCapabilities("editor", "session");
    for (const key of WORKSPACE_KEYS) expect(caps[key], key).toBe(false);
    expect(caps.canManageApprovalGovernance).toBe(false);
    expect(caps.hasRestrictedWorkspaceControls).toBe(true);
  });

  it("withholds every workspace control from a viewer", () => {
    const caps = settingsCapabilities("viewer", "session");
    for (const key of WORKSPACE_KEYS) expect(caps[key], key).toBe(false);
    expect(caps.hasRestrictedWorkspaceControls).toBe(true);
  });

  it("denies an unrecognised role rather than guessing", () => {
    const caps = settingsCapabilities("superuser", "session");
    for (const key of WORKSPACE_KEYS) expect(caps[key], key).toBe(false);
    expect(caps.canManageApprovalGovernance).toBe(false);
  });

  it("denies a missing role", () => {
    expect(settingsCapabilities(null).hasRestrictedWorkspaceControls).toBe(true);
    expect(settingsCapabilities(undefined).canManageWorkspace).toBe(false);
  });

  it("default-denies an API-key session even when the role says admin", () => {
    // The mobile login response does not expose API-key scopes, so offering
    // admin controls there is a predictable 403 rather than an affordance.
    const caps = settingsCapabilities("admin", "api_key");
    for (const key of WORKSPACE_KEYS) expect(caps[key], key).toBe(false);
    expect(caps.canManageApprovalGovernance).toBe(false);
    expect(caps.hasRestrictedWorkspaceControls).toBe(true);
  });

  it("normalises role casing and surrounding whitespace", () => {
    expect(settingsCapabilities("  Admin ", "session").canManageWorkspace).toBe(
      true,
    );
  });

  it("answers exactly the eight questions the screen asks", () => {
    // A new capability that the screen reads but this object never answers
    // renders as `undefined` — a hidden section with no notice explaining it.
    expect(Object.keys(settingsCapabilities("admin", "session")).sort()).toEqual(
      [
        "canManageApprovalGovernance",
        "canManageNotifications",
        "canManagePrivacy",
        "canManageRetention",
        "canManageVoiceLabels",
        "canManageWebhooks",
        "canManageWorkspace",
        "hasRestrictedWorkspaceControls",
      ],
    );
  });
});
