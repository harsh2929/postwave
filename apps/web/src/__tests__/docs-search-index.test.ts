// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { STATIC_DOCS } from "@/lib/docs/search.server";

function staticDoc(title: string) {
  const doc = STATIC_DOCS.find((entry) => entry.title === title);
  if (!doc) throw new Error(`missing static doc: ${title}`);
  return doc;
}

describe("docs search index copy", () => {
  it("indexes ActiveCampaign migration auth as API token plus account URL", () => {
    const migrations = staticDoc("Migrations");
    const activecampaign = staticDoc("ActiveCampaign migration");

    expect(migrations.body).toContain(
      "ActiveCampaign API token plus account API URL",
    );
    expect(migrations.body).not.toContain("OAuth API key authentication");
    expect(activecampaign.body).toContain("API URL and token");
    expect(activecampaign.body).toContain("account_id extra.api_url");
    expect(activecampaign.body).toContain("source-event replay");
  });
});
