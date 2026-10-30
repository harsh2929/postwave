import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const configureApp = require(resolve(process.cwd(), "app.config.js")) as (input: {
  config: Record<string, unknown>;
}) => Record<string, unknown>;

const originalProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const originalOwner = process.env.EXPO_OWNER;
const originalProfile = process.env.EXPO_PUBLIC_BUILD_PROFILE;

afterEach(() => {
  if (originalProjectId === undefined) {
    delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  } else {
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID = originalProjectId;
  }
  if (originalOwner === undefined) {
    delete process.env.EXPO_OWNER;
  } else {
    process.env.EXPO_OWNER = originalOwner;
  }
  if (originalProfile === undefined) {
    delete process.env.EXPO_PUBLIC_BUILD_PROFILE;
  } else {
    process.env.EXPO_PUBLIC_BUILD_PROFILE = originalProfile;
  }
});

describe("Expo project binding", () => {
  it("injects the protected owner and project UUID into resolved config", () => {
    process.env.EXPO_OWNER = "postwave";
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID =
      "123e4567-e89b-12d3-a456-426614174000";
    // A project id now implies an update channel, and an update channel
    // outside development must be code-signed or app.config.js refuses to
    // resolve (src/lib/easUpdateCodeSigning.test.ts holds that rule). This
    // case is about owner/project injection, not about signing, so it asks
    // for the one profile that may poll unsigned.
    process.env.EXPO_PUBLIC_BUILD_PROFILE = "development";

    const result = configureApp({
      config: { extra: { router: { origin: "https://app.moosewave.com" } } },
    }) as {
      owner?: string;
      extra?: { router?: unknown; eas?: { projectId?: string } };
    };

    expect(result.owner).toBe("postwave");
    expect(result.extra?.eas?.projectId).toBe(
      "123e4567-e89b-12d3-a456-426614174000",
    );
    expect(result.extra?.router).toEqual({
      origin: "https://app.moosewave.com",
    });
  });

  it("does not invent a release-project binding for local development", () => {
    delete process.env.EXPO_OWNER;
    delete process.env.EXPO_PUBLIC_EAS_PROJECT_ID;

    const result = configureApp({ config: { name: "Moosewave" } }) as {
      owner?: string;
      extra?: { eas?: unknown };
    };

    expect(result.owner).toBeUndefined();
    expect(result.extra?.eas).toBeUndefined();
  });
});
