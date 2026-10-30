// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

/**
 * A mandate as the LIST endpoint returns it. The token is never here.
 *
 * It exists only in the agent's memory and as a hash on the server, so a list
 * that could hand it back would make every reader of this page able to act as
 * the agent (`mandate/handlers.go` List).
 */
export interface AgentMandateSummary {
  id: string;
  purpose: string;
  actions: string[];
  resources: string[];
  uses_remaining: number;
  expires_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

/** Returned ONCE by create(). `notice` says so in words meant for a human. */
export interface AgentMandateMinted {
  id: string;
  token: string;
  expires_at: string;
  uses: number;
  notice: string;
}

export interface AgentMandateGrant {
  purpose: string;
  actions: string[];
  resources: string[];
  /** 1..10000. Outside that range the server answers 422 `invalid_grant`. */
  uses: number;
  ttl_seconds: number;
}

/**
 * Agent mandates — the surface a PERSON uses to grant, review and withdraw an
 * agent's authority.
 *
 * ── SESSION-ONLY, AND THAT IS THE POINT ────────────────────────────────────
 * Every route here refuses an API key with 403 `session_required`. This is not
 * an oversight to work around: an API key has no granting person behind it, so
 * a key that could mint a mandate would let an agent grant itself authority —
 * and a self-issued bound is not a bound. The server states this at
 * `mandate/handlers.go` (`actor`), and it means an SDK instance authenticated
 * with an API key can reach NONE of these methods. Use a session-bearing
 * client (a signed-in user's cookie or session token).
 *
 * ── WHY REVOKE IS THE INTERESTING VERB ─────────────────────────────────────
 * `list()` deliberately includes revoked and expired mandates: "what was this
 * agent allowed to do an hour ago" is the same question as "what is it allowed
 * to do now", asked after something went wrong, and a list that hid them could
 * not answer it. `revoke()` answers 200 even for an id that does not exist or
 * is already revoked — the caller's intent ("this must not work any more") is
 * satisfied either way, and a 404 would invite a retry loop against a mandate
 * that is already off.
 */
export class AgentMandatesResource extends Resource {
  /** GET /api/v1/agent-mandates — includes revoked and expired. */
  list(): Promise<{ data: AgentMandateSummary[] }> {
    return this.client.request("GET", "/api/v1/agent-mandates");
  }

  /**
   * POST /api/v1/agent-mandates — mint a mandate.
   *
   * The response carries the ONLY copy of the bearer token. Capture it before
   * discarding the response; it cannot be retrieved later, and a lost token
   * means minting a second mandate while the first stays live until it expires.
   */
  create(grant: AgentMandateGrant): Promise<AgentMandateMinted> {
    return this.client.request("POST", "/api/v1/agent-mandates", {
      body: grant,
    });
  }

  /** DELETE /api/v1/agent-mandates/{id} — idempotent; 200 even if already off. */
  revoke(id: string): Promise<{ revoked: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/agent-mandates/${encodeURIComponent(id)}`,
    );
  }
}
