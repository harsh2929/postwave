/**
 * subscriberFederation — parsing the link list WITH its write token, the
 * provenance vocabulary, and the UUID gate on manual link creation.
 */
import { describe, expect, it } from "vitest";

import {
  buildCreateLinkBody,
  createLinkProblem,
  federationMatchLabel,
  parseFederationLinks,
} from "./subscriberFederation";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MASTER = "22222222-2222-4222-8222-222222222222";

describe("parseFederationLinks", () => {
  it("keeps the rows AND the subscriber_version the writes must echo", () => {
    const view = parseFederationLinks({
      items: [
        {
          id: "fl-1",
          parent_tenant_id: TENANT,
          master_subscriber_id: MASTER,
          match_type: "email",
          match_key: "ada@acme.dev",
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
      subscriber_version: '"v9"',
    });
    expect(view.subscriberVersion).toBe('"v9"');
    expect(view.links[0]).toMatchObject({
      id: "fl-1",
      parentTenantId: TENANT,
      masterSubscriberId: MASTER,
      matchType: "email",
    });
  });

  it("degrades junk to an empty view with no token", () => {
    expect(parseFederationLinks(null)).toEqual({
      links: [],
      subscriberVersion: "",
    });
  });
});

describe("link creation rules", () => {
  it("labels the three provenances and passes unknowns through", () => {
    expect(federationMatchLabel("email")).toBe("Matched by email");
    expect(federationMatchLabel("external_id")).toBe("Matched by external id");
    expect(federationMatchLabel("manual")).toBe("Linked manually");
    expect(federationMatchLabel("sso")).toBe("sso");
  });

  it("refuses non-UUID ids before the round-trip", () => {
    expect(
      createLinkProblem({ parentTenantId: "acme", masterSubscriberId: MASTER }),
    ).toMatch(/parent workspace/);
    expect(
      createLinkProblem({ parentTenantId: TENANT, masterSubscriberId: "x" }),
    ).toMatch(/master subscriber/);
    expect(
      createLinkProblem({ parentTenantId: TENANT, masterSubscriberId: MASTER }),
    ).toBeNull();
  });

  it("builds the CreateFederationLinkInput body with manual provenance", () => {
    expect(
      buildCreateLinkBody({
        parentTenantId: ` ${TENANT} `,
        masterSubscriberId: MASTER,
      }),
    ).toEqual({
      parent_tenant_id: TENANT,
      master_subscriber_id: MASTER,
      match_type: "manual",
    });
  });
});
