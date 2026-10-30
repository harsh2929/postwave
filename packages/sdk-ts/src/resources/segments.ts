// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";

/** A node in the segment AST returned by the compiler. */
export interface SegmentNode {
  op: string;
  field?: string;
  value?: unknown;
  children?: SegmentNode[];
  [key: string]: unknown;
}

export interface Segment {
  id: string;
  name: string;
  query_ast: SegmentNode;
  created_at?: string;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  query_ast: SegmentNode;
}

export interface UpdateSegmentInput {
  name?: string;
  description?: string;
  query_ast?: SegmentNode;
}

export interface SegmentListPage {
  items: Segment[];
  next_cursor?: string | null;
}

export interface CompileFromTextResponse {
  query_ast: SegmentNode;
  rationale?: string;
  suggested_name?: string;
}

export class SegmentsResource extends Resource {
  /**
   * List segments.
   *
   * THE SERVER RETURNS A BARE ARRAY, not the envelope this method's return
   * type promises. `apps/api/internal/segments/handlers.go` List writes
   * `Repo.List`'s slice straight out, and a live probe against a running API
   * confirms it: `GET /api/v1/segments` -> `[{...}]`.
   *
   * Returning that array unchanged made this signature a lie, and the lie is
   * the silent kind: a caller writing `page.items.map(...)` gets `undefined`
   * and renders an EMPTY SEGMENT LIST that is indistinguishable from a
   * workspace with no segments. apps/mobile hit exactly this and had to stop
   * using the SDK for segments (see apps/mobile/src/api/segments.ts).
   *
   * So normalise here rather than propagate it: accept the array the server
   * sends today AND the envelope it may send later, and always hand back the
   * declared shape.
   */
  async list(params: { cursor?: string } = {}): Promise<SegmentListPage> {
    const raw = await this.client.request<unknown>("GET", "/api/v1/segments", {
      query: { cursor: params.cursor },
    });
    if (Array.isArray(raw)) return { items: raw as Segment[], next_cursor: null };
    const page = (raw ?? {}) as Partial<SegmentListPage>;
    return {
      items: Array.isArray(page.items) ? page.items : [],
      next_cursor: page.next_cursor ?? null,
    };
  }

  get(id: string): Promise<Segment> {
    return this.client.request(
      "GET",
      `/api/v1/segments/${encodeURIComponent(id)}`,
    );
  }

  create(input: CreateSegmentInput): Promise<Segment> {
    return this.client.request("POST", "/api/v1/segments", { body: input });
  }

  update(id: string, input: UpdateSegmentInput): Promise<Segment> {
    return this.client.request(
      "PATCH",
      `/api/v1/segments/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/segments/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Compile a natural-language description into a SegmentNode AST via
   * the server-side AI-backed compiler.
   */
  compileFromNaturalLanguage(text: string): Promise<CompileFromTextResponse> {
    return this.client.request(
      "POST",
      "/api/v1/segments/compile-from-text",
      { body: { text } },
    );
  }
}
