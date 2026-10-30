// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface ScimTokenInfo {
  id: string;
  prefix: string;
  description: string;
  created_at: string;
  revoked_at?: string | null;
  last_used_at?: string | null;
}

/** Returned ONCE on POST /api/v1/scim/tokens — copy and store immediately. */
export interface ScimTokenMinted {
  id: string;
  token: string;
  prefix: string;
}

export interface ScimRoleMapping {
  id: string;
  group_name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  precedence: number;
  created_at: string;
}

/**
 * SCIM admin — tokens used by your IdP (Okta / Azure AD / JumpCloud)
 * to authenticate to /scim/v2/* plus role-mapping CRUD for the SAML
 * JIT bridge. Note the one-shot reveal contract on token creation:
 * the raw token is only returned by createToken(); it is not
 * recoverable from list() afterward.
 */
export class ScimResource extends Resource {
  listTokens(): Promise<{ tokens: ScimTokenInfo[] }> {
    return this.client.request("GET", "/api/v1/scim/tokens");
  }

  createToken(input: { description?: string } = {}): Promise<ScimTokenMinted> {
    return this.client.request("POST", "/api/v1/scim/tokens", { body: input });
  }

  revokeToken(id: string): Promise<{ revoked: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/scim/tokens/${encodeURIComponent(id)}`,
    );
  }

  listRoleMappings(): Promise<{ mappings: ScimRoleMapping[] }> {
    return this.client.request("GET", "/api/v1/scim/role-mappings");
  }

  /**
   * Upsert by group_name. Use "*" as the catch-all group when no
   * specific group matches. Lower precedence is checked first.
   */
  upsertRoleMapping(input: {
    group_name: string;
    role: "owner" | "admin" | "editor" | "viewer";
    precedence?: number;
  }): Promise<ScimRoleMapping> {
    return this.client.request("POST", "/api/v1/scim/role-mappings", {
      body: input,
    });
  }

  deleteRoleMapping(id: string): Promise<{ deleted: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/scim/role-mappings/${encodeURIComponent(id)}`,
    );
  }
}
