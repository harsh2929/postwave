// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";
import { integrationPathSegment } from "./integrations.js";

/** Request body for POST /api/v1/audiences/lookalike (SUB-033). */
export interface CreateLookalikeInput {
  /** Optional display name for the generated audience. */
  name?: string;
  /** The segment whose members define the lookalike seed. Required. */
  seed_segment_id: string;
  /** Target audience size; bounded server-side to [100, 10000]; default 1000. */
  size?: number;
  /** Optional similarity floor in [0,1]; candidates below it are dropped. */
  confidence_threshold?: number | null;
}

export type LookalikeStatus = "pending" | "running" | "ready" | "failed" | string;

/** SUB-033 lookalike-audience metadata header. */
export interface LookalikeModel {
  id: string;
  name?: string;
  seed_segment_id: string;
  size_requested: number;
  member_count: number;
  seed_count: number;
  confidence_threshold?: number | null;
  model_version: string;
  status: LookalikeStatus;
  payload?: Record<string, unknown>;
  error?: string;
  created_at?: string;
  updated_at?: string;
}

/** One ranked, modeled member of a lookalike audience. */
export interface LookalikeMember {
  subscriber_id: string;
  email?: string;
  similarity_score: number;
  rank: number;
  features?: Record<string, unknown>;
}

/** Paginated ranked members of a lookalike audience. */
export interface LookalikeMemberPage {
  items: LookalikeMember[];
  total: number;
  page: number;
  per_page: number;
}

/** Options for paginating lookalike members. */
export interface LookalikeMembersOptions {
  page?: number;
  per_page?: number;
}

/**
 * Audiences surface — first-party lookalike audiences (SUB-033).
 *
 * Distinct from `subscribers.lookalike*` (SUB-068) which target the
 * /api/v1/subscribers/lookalike endpoints.
 */
export class AudiencesResource extends Resource {
  /** Generate a lookalike audience from a seed segment. */
  generate(input: CreateLookalikeInput): Promise<LookalikeModel> {
    return this.client.request("POST", "/api/v1/audiences/lookalike", {
      body: input,
    });
  }

  /** Read the metadata header for one generated lookalike audience. */
  get(id: string): Promise<LookalikeModel> {
    return this.client.request(
      "GET",
      `/api/v1/audiences/lookalike/${integrationPathSegment(id, "lookalike audience id")}`,
    );
  }

  /** List the ranked members of a lookalike audience, paginated. */
  members(id: string, opts: LookalikeMembersOptions = {}): Promise<LookalikeMemberPage> {
    return this.client.request(
      "GET",
      `/api/v1/audiences/lookalike/${integrationPathSegment(id, "lookalike audience id")}/members`,
      { query: { page: opts.page, per_page: opts.per_page } },
    );
  }

  /** Discard a generated lookalike audience, cascading its members. */
  discard(id: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/audiences/lookalike/${integrationPathSegment(id, "lookalike audience id")}`,
    );
  }
}
