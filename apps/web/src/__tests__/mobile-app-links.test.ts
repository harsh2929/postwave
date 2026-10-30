import { afterEach, describe, expect, it } from "vitest";

import { ENTITIES } from "@postwave/route-map";

import {
  APP_LINK_PATHS,
  GET as getAppleAppSiteAssociation,
  MOBILE_DESTINATION_LINK_PATHS,
} from "../app/.well-known/apple-app-site-association/route";
import { GET as getAssetLinks } from "../app/.well-known/assetlinks.json/route";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("mobile universal/app link association routes", () => {
  it("serves AASA for auth and canonical entity universal-link paths", async () => {
    process.env.POSTWAVE_APPLE_TEAM_ID = "ABCDE12345";
    process.env.POSTWAVE_IOS_BUNDLE_ID = "com.moosewave.app";

    const res = getAppleAppSiteAssociation();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();

    const details = body.applinks.details[0];
    expect(details.appID).toBe("ABCDE12345.com.moosewave.app");
    expect(details.paths).toEqual(APP_LINK_PATHS);
    expect(details.paths).toEqual(
      expect.arrayContaining([
        "/auth",
        "/auth/magic",
        "/auth/reset",
        "/auth/oauth-return",
        "/magic-link",
        "/reset-password",
        // Device-authorization approval (QR / push "approve on a trusted device").
        "/cli/auth",
        // Address verification opens the app, not Safari.
        "/verify-email",
        "/app/approvals/*",
        "/app/subscribers/*",
        "/app/campaigns/*",
        "/app/sequences/*",
      ]),
    );

    // An AASA claim HIJACKS the path from Safari once the app is installed, so
    // claiming one the app cannot route replaces a working web page with a
    // dead end. `arrayContaining` above cannot catch an over-claim — assert
    // every app path EXACTLY, filtered by what mobile actually ships. Each
    // entity needs both its bare list URL and its wildcard detail URL; the
    // separately enumerated destinations are exact-only list screens.
    const appPaths = details.paths.filter((p: string) => p.startsWith("/app/"));
    const entityPaths = Object.values(ENTITIES)
      .filter((e) => e.surfaces.mobile !== "none")
      .flatMap((e) => [`/app/${e.slug}`, `/app/${e.slug}/*`]);
    const expectedAppPaths = [...entityPaths, ...MOBILE_DESTINATION_LINK_PATHS];
    expect([...appPaths].sort()).toEqual([...expectedAppPaths].sort());
    expect(new Set(appPaths).size).toBe(appPaths.length);
    for (const entity of Object.values(ENTITIES)) {
      if (entity.surfaces.mobile !== "none") continue;
      expect(appPaths, entity.key).not.toContain(`/app/${entity.slug}`);
      expect(appPaths, entity.key).not.toContain(`/app/${entity.slug}/*`);
    }
    for (const path of MOBILE_DESTINATION_LINK_PATHS) {
      expect(appPaths).toContain(path);
      expect(appPaths).not.toContain(`${path}/*`);
    }
    expect(details.components).toEqual(
      details.paths.map((path: string) => ({ "/": path })),
    );
    expect(details.paths).not.toEqual(
      expect.arrayContaining([
        "/auth/*",
        "/magic-link/*",
        "/reset-password/*",
        "/browser-auth/magic",
        "/browser-auth/reset",
      ]),
    );
  });

  it("declares webcredentials so iOS AutoFill binds to the domain", async () => {
    process.env.POSTWAVE_APPLE_TEAM_ID = "ABCDE12345";
    process.env.POSTWAVE_IOS_BUNDLE_ID = "com.moosewave.app";

    const body = await getAppleAppSiteAssociation().json();

    // The app.json entitlement (`webcredentials:app.moosewave.com`) is only
    // half the handshake; iOS also requires this key in the AASA document.
    expect(body.webcredentials).toEqual({
      apps: ["ABCDE12345.com.moosewave.app"],
    });
  });

  it("fails closed when the Apple Team ID is not configured", async () => {
    delete process.env.POSTWAVE_APPLE_TEAM_ID;

    const res = getAppleAppSiteAssociation();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("POSTWAVE_APPLE_TEAM_ID"),
    });
  });

  it("serves Android asset links with configured signing fingerprints", async () => {
    process.env.POSTWAVE_ANDROID_PACKAGE_NAME = "com.moosewave.app";
    process.env.POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS =
      "AA:BB:CC, 11:22:33";

    const res = getAssetLinks();
    expect(res.status).toBe(200);
    const body = await res.json();

    const target = {
      namespace: "android_app",
      package_name: "com.moosewave.app",
      sha256_cert_fingerprints: ["AA:BB:CC", "11:22:33"],
    };
    expect(body).toEqual([
      { relation: ["delegate_permission/common.handle_all_urls"], target },
      // Credential Manager / Smart Lock password sharing.
      { relation: ["delegate_permission/common.get_login_creds"], target },
    ]);
  });

  it("fails closed when Android signing fingerprints are not configured", async () => {
    delete process.env.POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS;

    const res = getAssetLinks();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining(
        "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS",
      ),
    });
  });
});
