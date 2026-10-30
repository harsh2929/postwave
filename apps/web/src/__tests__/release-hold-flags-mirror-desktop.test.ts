// SPDX-License-Identifier: AGPL-3.0-only
//
// The web availability flags that gate release-held verbs must read exactly
// what desktop reads — same value, same reason copy — or one client will
// overstate what the server can guarantee. The UI tests for these verbs mock
// the flag modules to prove both states, which means a flipped constant
// would be invisible to them; this file imports the REAL modules and compares
// them with the desktop source text, so a flip or a copy drift fails here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "@/lib/campaign-operational-availability";
import { CUSTOM_DOMAIN_REGISTRATION_AVAILABLE } from "@/lib/custom-domain-operational-availability";
import { createCustomDomain } from "@/lib/custom-domains-api";
import {
  SUPPORT_INTEGRATION_RUNTIME_AVAILABLE,
  SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE,
  SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE,
} from "@/lib/support-integration-operational-availability";
import { connectSupportIntegration } from "@/lib/support-integrations-api";
import {
  TAG_MERGE_AVAILABLE,
  TAG_MERGE_UNAVAILABLE_REASON,
} from "@/lib/tag-merge-availability";
import { mergeTags } from "@/lib/tags-api";

const DESKTOP = resolve(process.cwd(), "../desktop/src");
const desktop = (relativePath: string): string =>
  readFileSync(resolve(DESKTOP, relativePath), "utf8");

/** The string literal assigned to `name` in a desktop source file. */
function desktopConstant(file: string, name: string): string {
  const source = desktop(file);
  const match = new RegExp(
    `export const ${name}(?::\\s*boolean)?\\s*=\\s*\\n?\\s*("(?:[^"\\\\]|\\\\.)*"|false|true)`,
    "u",
  ).exec(source);
  if (!match) throw new Error(`${name} not found in ${file}`);
  const raw = match[1]!;
  return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
}

describe("release-held verbs: web flags mirror desktop", () => {
  it("tag merge (audience-103)", () => {
    expect(TAG_MERGE_AVAILABLE).toBe(false);
    expect(TAG_MERGE_UNAVAILABLE_REASON).toBe(
      desktopConstant("pages/tags/tagPageModel.ts", "TAG_MERGE_UNAVAILABLE_REASON"),
    );
  });

  it("support-provider runtime (platform-91)", () => {
    expect(SUPPORT_INTEGRATION_RUNTIME_AVAILABLE).toBe(false);
    expect(SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE).toBe(
      desktopConstant(
        "lib/api/support-integrations.ts",
        "SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE",
      ),
    );
    // Desktop inlines the held message in supportRuntimeHeld().
    expect(desktop("lib/api/support-integrations.ts")).toContain(
      JSON.stringify(SUPPORT_INTEGRATION_RUNTIME_HOLD_MESSAGE),
    );
  });

  it("campaign scheduling (campaigns-24)", () => {
    expect(CAMPAIGN_SCHEDULING_AVAILABLE).toBe(
      desktopConstant(
        "lib/campaign-operational-availability.ts",
        "CAMPAIGN_SCHEDULING_AVAILABLE",
      ) === "true",
    );
    expect(CAMPAIGN_SCHEDULING_AVAILABLE).toBe(false);
    expect(CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON).toBe(
      desktopConstant(
        "lib/campaign-operational-availability.ts",
        "CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON",
      ),
    );
  });

  it("custom-domain registration (deliverability-2)", () => {
    expect(CUSTOM_DOMAIN_REGISTRATION_AVAILABLE).toBe(false);
    expect(
      desktopConstant(
        "lib/custom-domain-operational-availability.ts",
        "CUSTOM_DOMAIN_REGISTRATION_AVAILABLE",
      ),
    ).toBe("false");
  });

  it("every held transport refuses before fetch with the real flags", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    try {
      await expect(mergeTags({ from: "a", into: "b" })).rejects.toMatchObject({
        code: "tag_merge_unavailable",
      });
      await expect(
        connectSupportIntegration({ provider: "zendesk" }),
      ).rejects.toMatchObject({ code: "support_integration_runtime_held" });
      await expect(
        createCustomDomain({ domain: "mail.example.com", purpose: "forms" }),
      ).rejects.toMatchObject({ code: "custom_domain_registration_unavailable" });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
