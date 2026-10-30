// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SMS_RELEASE_HOLD_CODES,
  SMS_RELEASE_STATUS_COPY,
  SMS_RELEASE_VERDICT,
} from "@/lib/sms-release-status";

const SRC = resolve(process.cwd(), "src");
const readSource = (path: string): string =>
  readFileSync(join(SRC, path), "utf8");

const PAGE = readSource("app/(marketing)/sms/page.tsx");
const OG = readSource("app/(marketing)/sms/opengraph-image.tsx");

describe("/sms public release claims", () => {
  it("shares one exact HOLD / NO-GO vocabulary", () => {
    expect(SMS_RELEASE_VERDICT).toBe("HOLD / NO-GO");
    expect(SMS_RELEASE_STATUS_COPY).toContain(
      "Do not configure customer traffic or provider credentials",
    );
    expect(new Set(Object.values(SMS_RELEASE_HOLD_CODES)).size).toBe(12);
    expect(SMS_RELEASE_HOLD_CODES).toMatchObject({
      reply: "sms_reply_dispatch_release_held",
      broadcast: "sms_broadcast_dispatch_release_held",
      a2p: "sms_a2p_registration_release_held",
      providerCallback: "sms_provider_callback_release_held",
      financial: "sms_financial_ledger_release_held",
      mms: "sms_mms_readiness_release_held",
      evidence: "sms_evidence_read_release_held",
    });
  });

  it("makes the dominant page and OG state structural hold truth", () => {
    for (const source of [PAGE, OG]) {
      expect(source).toContain('from "@/lib/sms-release-status"');
      expect(source).toContain("Hosted sending is held");
      expect(source).not.toContain("SMS that can&apos;t send without consent");
      expect(source).not.toContain("all on by default");
      expect(source).not.toContain("send a real test");
    }
    expect(PAGE).toContain("Do not activate customer SMS traffic");
    expect(OG).toContain("Dispatch held");
  });

  it("does not publish a provider, A2P, report, or delivery success claim", () => {
    expect(PAGE).toContain("tenant-bound provider vault");
    expect(PAGE).toContain("not device delivery");
    expect(PAGE).toContain("Private report/export evidence");
    expect(PAGE).not.toContain("Moosewave drives the registration flow");
    expect(PAGE).not.toContain("returns both the gate decision");
    expect(PAGE).not.toContain("all rows, or just blocked");
  });

  it("keeps home, features, comparison, and changelog on the same boundary", () => {
    const home = readSource("app/(marketing)/page.tsx");
    const features = readSource("app/(marketing)/features/page.tsx");
    const comparison = readSource("app/(marketing)/vs/page.tsx");
    const changelog = readSource("app/(marketing)/changelog/page.tsx");

    for (const source of [home, features, comparison, changelog]) {
      expect(source).toContain('from "@/lib/sms-release-status"');
    }
    expect(comparison).toMatch(/dimension: "SMS"[\s\S]+?moosewave: "Partial"/u);
    expect(changelog).toContain("Historical source milestone");
    expect(changelog).not.toContain("a full SMS / mobile-push channel");
  });
});
