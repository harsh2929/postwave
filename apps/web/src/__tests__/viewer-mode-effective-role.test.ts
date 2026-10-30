// SPDX-License-Identifier: AGPL-3.0-only
//
// View-as-Viewer must be honoured by the pages a reviewer would actually check.
//
// The maintenance page's preview sets `effective_role` on the session and
// promises "Writes will be refused exactly as they would be for a real viewer."
// The server keeps that promise (routeauth reads EffectiveRoleOrDurable), but
// three dashboard pages computed their write capability from the DURABLE role,
// so during a preview the Save/publish/decay controls stayed enabled and the
// page reported a capability the server would refuse. No escalation — but the
// preview answered the one question it exists to answer incorrectly.
//
// The guard is source-level because these are large client pages with heavy
// data dependencies; what it pins is the wiring: a page that gates on
// roleCanWrite must derive its role through effectiveAuthRole.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), "src", rel), "utf8");

// Every dashboard page that gates writes on the durable-vs-effective
// distinction. The three at the top are the ones that had the defect; the rest
// were already correct and are listed so a regression in either direction is
// caught.
const GATED_PAGES = [
  {
    file: "app/(dashboard)/app/settings/sender/page.tsx",
    authority: "roleCanWrite",
  },
  {
    file: "app/(dashboard)/app/landing-pages/[id]/page.tsx",
    authority: "canAdminLandingPages",
  },
  {
    file: "app/(dashboard)/app/subscribers/segments/[id]/page.tsx",
    authority: "subscriberAuthorityFromMe",
  },
  {
    file: "app/(dashboard)/app/settings/api/page.tsx",
    authority: "roleCanWrite",
  },
  {
    file: "app/(dashboard)/app/settings/audit-sinks/page.tsx",
    authority: "roleCanWrite",
  },
  {
    file: "app/(dashboard)/app/settings/domain/page.tsx",
    authority: "canReadAdminData",
  },
  {
    file: "app/(dashboard)/app/settings/privacy/page.tsx",
    authority: "roleCanWrite",
  },
  {
    file: "app/(dashboard)/app/settings/topics/page.tsx",
    authority: "roleCanWrite",
  },
  {
    file: "app/(dashboard)/app/settings/topics/[id]/edit/page.tsx",
    authority: "roleCanWrite",
  },
  {
    file: "app/(dashboard)/app/settings/webhooks/page.tsx",
    authority: "canAdminOutboundWebhooks",
  },
  {
    file: "app/(dashboard)/app/settings/team/page-client.tsx",
    authority: "canReadAdminData",
  },
] as const;

describe("dashboard write gates read the effective role", () => {
  for (const { file, authority } of GATED_PAGES) {
    it(`${file} derives its role through effectiveAuthRole`, () => {
      const source = read(file);
      expect(source).toContain(authority);
      expect(source).toContain("effectiveAuthRole");
    });

    it(`${file} never reads the durable role into the write gate`, () => {
      const source = read(file);
      // `me.data?.role ?? null` / `meQuery.data?.role ?? null` is the exact
      // shape that produced the bug: the durable role bound to the variable the
      // page then feeds to roleCanWrite.
      expect(source).not.toMatch(/\w+(?:Query)?\.data\?\.role \?\? null/);
      // ...and no call site may pass a `.role` read straight in.
      expect(source).not.toMatch(/roleCanWrite\(\s*\w+(\.data)?\??\.role/);
    });
  }
});
