import { describe, expect, it } from "vitest";
import {
  ENTITIES,
  ENTITY_KEYS,
  UNIVERSAL_HOST,
  buildDeepLink,
  buildDeviceApproveLink,
  buildUniversalLink,
  desktopPath,
  mobilePath,
  parseDeepLink,
  parseDeviceApproveLink,
  parseUniversalLink,
  isEntityResourceId,
  isSafeResourceId,
  webPath,
  type EntityDef,
} from "./index";

const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function validId(def: EntityDef): string {
  return def.idPolicy === "uuid" ? CONVERSATION_ID : "x1";
}

describe("route builders", () => {
  it("builds web/desktop dashboard routes", () => {
    expect(webPath("campaign", "cam_1")).toBe("/app/campaigns/cam_1");
    expect(webPath("subscriber", "sub_42")).toBe("/app/subscribers/sub_42");
  });

  it("addresses an approval by id now that web ships approvals/[id]", () => {
    // Regression pin. This path was a Next.js 404 for as long as the registry
    // addressed approvals by id without web having the route — reached by the
    // resume card, the activity feed, "copy link" and mobile's continue-on-web
    // handoff. Keeping the id (rather than degrading the link) is what lets
    // mobile's app/(tabs)/approvals/[id].tsx open the exact request.
    expect(webPath("approval", "ap_9")).toBe("/app/approvals/ap_9");
    expect(buildUniversalLink("approval", "ap_9")).toBe(
      "https://app.moosewave.com/app/approvals/ap_9",
    );
  });

  it("resolves every surface off the registry, never a hardcoded entity", () => {
    const cases: [
      (e: string, i: string) => string | null,
      keyof EntityDef["surfaces"],
      string,
    ][] = [
      [webPath, "web", "/app"],
      [desktopPath, "desktop", "/app"],
      [mobilePath, "mobile", "/(tabs)"],
    ];
    for (const def of Object.values(ENTITIES)) {
      const id = validId(def);
      for (const [build, surface, base] of cases) {
        const support = def.surfaces[surface];
        const want =
          support === "none"
            ? null
            : support === "detail"
              ? `${base}/${def.slug}/${id}`
              : `${base}/${def.slug}`;
        expect(build(def.key, id), `${def.key}/${surface}`).toBe(want);
      }
    }
  });

  it("rejects a non-string id instead of throwing on it", () => {
    // The annotation used to be `(id: string)`, but every caller validates
    // something from OUTSIDE the type system — a URL segment, a share payload,
    // a server response, a rehydrated cache. A non-string reached `id.length`
    // and threw DURING RENDER, which took down the mobile dashboard.
    for (const bad of [undefined, null, 42, {}, [], true, Symbol("x")]) {
      expect(isSafeResourceId(bad as unknown as string), String(bad)).toBe(
        false,
      );
    }
    // …and the path builders stay total for the same inputs.
    for (const bad of [undefined, null, 42, {}]) {
      expect(webPath("campaign", bad as unknown as string)).toBeNull();
      expect(desktopPath("campaign", bad as unknown as string)).toBeNull();
      expect(mobilePath("campaign", bad as unknown as string)).toBeNull();
      expect(buildDeepLink("campaign", bad as unknown as string)).toBeNull();
      expect(
        buildUniversalLink("campaign", bad as unknown as string),
      ).toBeNull();
    }
  });

  it("returns null rather than a path to a screen the surface never shipped", () => {
    // Mobile has no Affiliates tab; web has no segments/helpdesk collection;
    // desktop's automation section is `automations`, not `flows`.
    // Each of these would previously have produced a confident-looking path
    // into a route that does not exist.
    expect(mobilePath("affiliate", "af_1")).toBeNull();
    expect(webPath("segment", "sg_1")).toBeNull();
    expect(desktopPath("flow", "fl_1")).toBeNull();
    // NOTE the key is `landing-page`, not `landingPage` — entity keys double as
    // `moosewave://<action>/…` and the Rust grammar accepts only [a-z-]. Using
    // the camelCase spelling here would make this assertion vacuous: getEntity
    // returns undefined and the null comes from the unknown key, not from the
    // surfaces value it is meant to be testing.
    expect(desktopPath("landing-page", "lp_1")).toBeNull();
    expect(buildUniversalLink("segment", "sg_1")).toBeNull();
  });

  it("desktop is not an alias of web — their section vocabularies differ", () => {
    // `desktopPath = webPath` silently claimed desktop could render every web
    // route. It cannot: desktop-router.ts SECTION_SLUGS has no `flows`,
    // `landing-pages` or `inbound-webhooks`; lists now have detail on both.
    expect(desktopPath("list", "l_1")).toBe("/app/lists/l_1");
    expect(webPath("list", "l_1")).toBe("/app/lists/l_1");
    expect(webPath("flow", "fl_1")).toBe("/app/flows/fl_1");
    expect(desktopPath("flow", "fl_1")).toBeNull();
  });

  it("builds mobile routes (detail vs list)", () => {
    expect(mobilePath("campaign", "cam_1")).toBe("/(tabs)/campaigns/cam_1");
    // approval GAINED a mobile detail screen — apps/mobile/app/(tabs)/
    // approvals/[id].tsx — so the flag moved and this expectation with it.
    // While it read `false`, the "approve on your phone" link landed the
    // approver on the queue instead of the request they were notified about.
    expect(mobilePath("approval", "ap_9")).toBe("/(tabs)/approvals/ap_9");
  });

  it("drives the list fallback off the flag, not off a hardcoded entity", () => {
    // Asserting THROUGH the registry rather than pinning entities keeps the
    // fallback proven as the entity set grows, and fails loudly if someone
    // claims a detail screen mobile does not have.
    for (const def of Object.values(ENTITIES)) {
      const support = def.surfaces.mobile;
      const id = validId(def);
      expect(mobilePath(def.key, id), def.key).toBe(
        support === "none"
          ? null
          : support === "detail"
            ? `/(tabs)/${def.slug}/${id}`
            : `/(tabs)/${def.slug}`,
      );
    }
  });

  it("builds the moosewave:// deep link with the singular action", () => {
    expect(buildDeepLink("campaign", "cam_1")).toBe(
      "moosewave://campaign/cam_1",
    );
  });

  it("builds the shareable universal link", () => {
    expect(buildUniversalLink("subscriber", "sub_42")).toBe(
      "https://app.moosewave.com/app/subscribers/sub_42",
    );
  });

  it("rejects unknown entities and unsafe ids", () => {
    expect(webPath("nope", "x")).toBeNull();
    expect(buildDeepLink("campaign", "../sign-out")).toBeNull();
    expect(buildDeepLink("campaign", "a/b")).toBeNull();
    expect(buildDeepLink("campaign", "")).toBeNull();
  });

  it("routes only canonical conversation UUIDs and fails old ticket links closed", () => {
    expect(mobilePath("helpdesk-conversation", CONVERSATION_ID)).toBe(
      `/(tabs)/helpdesk/${CONVERSATION_ID}`,
    );
    expect(desktopPath("helpdesk-conversation", CONVERSATION_ID)).toBe(
      `/app/helpdesk/${CONVERSATION_ID}`,
    );
    expect(buildDeepLink("helpdesk-conversation", CONVERSATION_ID)).toBe(
      `moosewave://helpdesk-conversation/${CONVERSATION_ID}`,
    );
    expect(isEntityResourceId("helpdesk-conversation", CONVERSATION_ID)).toBe(
      true,
    );
    expect(mobilePath("helpdesk-conversation", "ticket_123")).toBeNull();
    expect(mobilePath("helpdesk-ticket", CONVERSATION_ID)).toBeNull();
    expect(buildDeepLink("helpdesk-ticket", CONVERSATION_ID)).toBeNull();
  });
});

describe("parseDeepLink", () => {
  it("parses the canonical scheme", () => {
    expect(parseDeepLink("moosewave://campaign/cam_1")).toEqual({
      entity: "campaign",
      id: "cam_1",
    });
  });
  it("ignores query/hash (presentation hints, not identity)", () => {
    expect(parseDeepLink("moosewave://campaign/cam_1?from=email")).toEqual({
      entity: "campaign",
      id: "cam_1",
    });
  });
  it("rejects unknown actions, traversal, missing id, wrong scheme", () => {
    expect(parseDeepLink("moosewave://migrations/api-key")).toBeNull();
    expect(parseDeepLink("moosewave://approval/")).toBeNull();
    expect(parseDeepLink("moosewave://approval")).toBeNull();
    expect(parseDeepLink("moosewave://campaign/a/b")).toBeNull();
    expect(
      parseDeepLink("https://app.moosewave.com/app/campaigns/cam_1"),
    ).toBeNull();
  });
  it("does NOT collapse empty segments (strict, matches desktop grammar)", () => {
    expect(parseDeepLink("moosewave://campaign//cam_1")).toBeNull();
    expect(parseDeepLink("moosewave://campaign/cam_1/")).toBeNull();
    expect(parseDeepLink("moosewave:///cam_1")).toBeNull();
  });

  it("parses only the conversation action with a canonical UUID", () => {
    expect(
      parseDeepLink(`moosewave://helpdesk-conversation/${CONVERSATION_ID}`),
    ).toEqual({ entity: "helpdesk-conversation", id: CONVERSATION_ID });
    expect(
      parseDeepLink(`moosewave://helpdesk-ticket/${CONVERSATION_ID}`),
    ).toBeNull();
    expect(
      parseDeepLink("moosewave://helpdesk-conversation/ticket_123"),
    ).toBeNull();
  });
});

describe("parseUniversalLink", () => {
  it("parses a full https app link", () => {
    expect(
      parseUniversalLink("https://app.moosewave.com/app/campaigns/cam_1"),
    ).toEqual({ entity: "campaign", id: "cam_1" });
  });
  it("parses a bare /app path", () => {
    expect(parseUniversalLink("/app/subscribers/sub_42")).toEqual({
      entity: "subscriber",
      id: "sub_42",
    });
  });
  it("rejects a foreign host, non-https scheme, and unknown slugs", () => {
    expect(
      parseUniversalLink("https://evil.example/app/campaigns/c1"),
    ).toBeNull();
    expect(
      parseUniversalLink("http://app.moosewave.com/app/campaigns/c1"),
    ).toBeNull();
    expect(parseUniversalLink("/app/widgets/w1")).toBeNull();
  });

  it("accepts a multi-region / self-host allowlist without widening trust", () => {
    const hosts = ["app.moosewave.com", "app.eu.moosewave.com", "mail.acme.com"];
    // A region/self-host link routes when its host is allow-listed…
    expect(
      parseUniversalLink("https://app.eu.moosewave.com/app/campaigns/c1", hosts),
    ).toEqual({ entity: "campaign", id: "c1" });
    expect(
      parseUniversalLink("https://mail.acme.com/app/subscribers/s1", hosts),
    ).toEqual({ entity: "subscriber", id: "s1" });
    // …but a host NOT in the allowlist is still rejected (anti-spoofing holds).
    expect(
      parseUniversalLink("https://evil.example/app/campaigns/c1", hosts),
    ).toBeNull();
    // The canonical host is rejected if the caller's allowlist omits it.
    expect(
      parseUniversalLink("https://app.moosewave.com/app/campaigns/c1", [
        "mail.acme.com",
      ]),
    ).toBeNull();
  });

  it("maps the helpdesk slug only to a canonical conversation UUID", () => {
    expect(parseUniversalLink(`/app/helpdesk/${CONVERSATION_ID}`)).toEqual({
      entity: "helpdesk-conversation",
      id: CONVERSATION_ID,
    });
    expect(parseUniversalLink("/app/helpdesk/ticket_123")).toBeNull();
  });
});

describe("deep-link <-> universal-link round trip", () => {
  it("every entity round-trips through the deep-link scheme", () => {
    // The `moosewave://` link is the canonical identity carrier and is
    // surface-independent — it always keeps the id, and each app resolves it
    // through its own path builder.
    for (const key of ENTITY_KEYS) {
      const id = validId(ENTITIES[key]);
      const deep = buildDeepLink(key, id)!;
      expect(parseDeepLink(deep), key).toEqual({ entity: key, id });
    }
  });

  it("round-trips the universal link for every web-addressable entity", () => {
    for (const key of ENTITY_KEYS) {
      const id = validId(ENTITIES[key]);
      const uni = buildUniversalLink(key, id);
      const support = ENTITIES[key].surfaces.web;
      if (support === "none") {
        // Web cannot serve it, so there is no shareable https link to mint.
        expect(uni, key).toBeNull();
        continue;
      }
      if (support === "list") {
        // A list landing carries no id, so it is not an entity ref. Assert the
        // shape explicitly rather than letting a null parse look like a pass.
        expect(uni, key).toBe(
          `https://${UNIVERSAL_HOST}/app/${ENTITIES[key].slug}`,
        );
        expect(parseUniversalLink(uni!), key).toBeNull();
        continue;
      }
      expect(parseUniversalLink(uni!), key).toEqual({ entity: key, id });
    }
  });
});

describe("parseDeviceApproveLink", () => {
  it("parses the canonical device-approve universal link", () => {
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toEqual({ userCode: "ABCD-EFGH" });
  });

  it("rejects non-canonical case or encoded surrounding whitespace", () => {
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=abcd-efgh",
      ),
    ).toBeNull();
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=%20wxyz-1234%20",
      ),
    ).toBeNull();
  });

  it("rejects a non-https scheme, wrong host, or wrong path (anti-spoof)", () => {
    // http:// downgrade — universal links are verified-domain-only.
    expect(
      parseDeviceApproveLink(
        "http://app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
    // Look-alike host not in the allow-list.
    expect(
      parseDeviceApproveLink(
        "https://evil.example/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
    // A custom scheme can be registered by any app — device approval must
    // arrive over the AASA-verified domain, so moosewave:// is rejected.
    expect(
      parseDeviceApproveLink("moosewave://cli/auth?user_code=ABCD-EFGH"),
    ).toBeNull();
    // Path must match exactly — no slash-folding onto a wildcard.
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth/x?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
    // The entity universal-link path is not an approval path.
    expect(
      parseDeviceApproveLink("https://app.moosewave.com/app/campaigns/c1"),
    ).toBeNull();
  });

  it("rejects a malformed or missing user_code", () => {
    for (const bad of [
      "https://app.moosewave.com/cli/auth", // no code
      "https://app.moosewave.com/cli/auth?user_code=", // empty
      "https://app.moosewave.com/cli/auth?user_code=ABCDEFGH", // no dash
      "https://app.moosewave.com/cli/auth?user_code=ABC-DEFG", // wrong length
      "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH-IJKL", // too long
    ]) {
      expect(parseDeviceApproveLink(bad)).toBeNull();
    }
  });

  it("rejects credential-in-URL / fragment smuggling", () => {
    expect(
      parseDeviceApproveLink(
        "https://user:pass@app.moosewave.com/cli/auth?user_code=ABCD-EFGH",
      ),
    ).toBeNull();
    expect(
      parseDeviceApproveLink(
        "https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH#evil",
      ),
    ).toBeNull();
  });

  it("honours a multi-region / self-host allow-list without widening trust", () => {
    const hosts = ["app.moosewave.com", "app.eu.moosewave.com"];
    expect(
      parseDeviceApproveLink(
        "https://app.eu.moosewave.com/cli/auth?user_code=WXYZ-1234",
        hosts,
      ),
    ).toEqual({ userCode: "WXYZ-1234" });
    // A host outside the allow-list is still rejected.
    expect(
      parseDeviceApproveLink(
        "https://app.other.com/cli/auth?user_code=WXYZ-1234",
        hosts,
      ),
    ).toBeNull();
  });

  it("round-trips through buildDeviceApproveLink", () => {
    const link = buildDeviceApproveLink("ABCD-EFGH")!;
    expect(link).toBe("https://app.moosewave.com/cli/auth?user_code=ABCD-EFGH");
    expect(parseDeviceApproveLink(link)).toEqual({ userCode: "ABCD-EFGH" });
    // Builder validates the code too.
    expect(buildDeviceApproveLink("bad")).toBeNull();
  });
});

describe("list routes do not depend on the id they never emit", () => {
  // suppression is web-"list", and a suppression is identified by an EMAIL
  // (apps/mobile ships suppressions/[email].tsx). Every email fails
  // isSafeResourceId, so webPath returned null and the "open on web"
  // affordance disappeared for every real suppression — even though the
  // emitted path contains no id at all.
  it("emits the collection route for an email-identified suppression", () => {
    expect(webPath("suppression", "user@example.com")).toBe(
      "/app/suppressions",
    );
  });

  it.each([
    ["template", "mobile"],
    ["migration", "mobile"],
    ["discount", "mobile"],
    ["integration", "web"],
  ] as const)(
    "emits %s's list route on %s regardless of id shape",
    (entity, surface) => {
      const build = surface === "web" ? webPath : mobilePath;
      const base = surface === "web" ? "/app" : "/(tabs)";
      expect(build(entity, "an unsafe id!")).toMatch(
        new RegExp(`^${base.replace(/[()]/g, "\\$&")}/[a-z-]+$`),
      );
    },
  );

  it("still refuses a DETAIL path with an unsafe id", () => {
    // The relaxation must not leak into paths that interpolate the id — that
    // is where a second path segment or a traversal would land.
    expect(webPath("campaign", "../../etc/passwd")).toBeNull();
    expect(webPath("campaign", "a/b")).toBeNull();
    expect(mobilePath("subscriber", "a b")).toBeNull();
    expect(webPath("campaign", "ok-id")).toBe("/app/campaigns/ok-id");
  });

  it("still returns null when the surface does not ship the entity", () => {
    // "none" must outrank the relaxation, or a link appears for a screen that
    // was never built.
    expect(mobilePath("affiliate", "anything at all")).toBeNull();
    expect(desktopPath("flow", "anything at all")).toBeNull();
  });
});
