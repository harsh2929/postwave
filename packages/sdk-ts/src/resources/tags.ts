// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";

export interface Tag {
  id: string;
  name: string;
  color?: string;
  description: string;
  group_id?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  updated_by?: string;
  archived_at?: string;
  pii: boolean;
  version: number;
  /** Exact strong token to echo in If-Match on update. */
  etag: string;
}

export type TagColor =
  | ""
  | "slate"
  | "teal"
  | "sky"
  | "indigo"
  | "violet"
  | "rose"
  | "amber"
  | "lime"
  | `#${string}`;

export interface CreateTagInput {
  name: string;
  color?: TagColor;
  description?: string;
  /** Tenant-owned UUID; an empty string creates an ungrouped tag. */
  group_id?: string;
  pii?: boolean;
}

export interface UpdateTagInput {
  name?: string;
  /** Empty string clears the color. */
  color?: TagColor;
  description?: string;
  /** Empty string clears the group. */
  group_id?: string;
  pii?: boolean;
}

export interface TagListOptions {
  query?: string;
  groupId?: string;
  includeArchived?: boolean;
}

export class TagsResource extends Resource {
  list(options: TagListOptions = {}): Promise<{ items: Tag[] }> {
    return this.client.request("GET", "/api/v1/tags", {
      query: {
        query: options.query,
        group_id: options.groupId,
        include_archived: options.includeArchived,
      },
    });
  }

  create(input: string | CreateTagInput): Promise<Tag> {
    return this.client.request("POST", "/api/v1/tags", {
      body: typeof input === "string" ? { name: input } : input,
    });
  }

  update(id: string, patch: UpdateTagInput, etag: string): Promise<Tag> {
    return this.client.request(
      "PATCH",
      `/api/v1/tags/${encodeURIComponent(id)}`,
      { body: patch, headers: { "If-Match": etag } },
    );
  }

  /**
   * @deprecated Permanent deletion is deliberately disabled server-side and
   * always rejects with `unsafe_mutation_disabled`; retained only so existing
   * integrations receive the explicit server contract.
   */
  delete(id: string): Promise<never> {
    return this.client.request(
      "DELETE",
      `/api/v1/tags/${encodeURIComponent(id)}`,
    );
  }
}
