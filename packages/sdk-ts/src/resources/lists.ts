// SPDX-License-Identifier: MIT

import { Resource } from "./_base.js";

export interface List {
  id: number;
  name: string;
  type?: string;
  optin?: string;
  tags?: string[];
  description?: string;
}

export interface CreateListInput {
  name: string;
  type?: "private" | "public";
  optin?: "single" | "double";
  tags?: string[];
  description?: string;
}

export interface SubscriberListReference {
  id: string;
  name: string;
}

/** One row of `GET /api/v1/lists/{id}/subscribers` (lists.MemberSubscriber). */
export interface ListMember {
  id: string;
  email: string;
  status: string;
  source?: string;
  added_at: string;
}

/** Response envelope of `GET /api/v1/lists/{id}/subscribers` (lists.MembersPage). */
export interface ListMembersPage {
  list_id: string;
  items: ListMember[];
  total: number;
  page: number;
  per_page: number;
}

/**
 * Query params for {@link ListsResource.members}. `query` and `q` are both
 * accepted by the server (listsearch.ReadQuery; `query` wins); the SDK sends
 * `q` so one spelling is used everywhere.
 */
export interface ListMembersParams {
  /** Case-insensitive substring match against the member's email. */
  q?: string;
  /** One of enabled | disabled | blocklisted | unconfirmed. */
  status?: "enabled" | "disabled" | "blocklisted" | "unconfirmed";
  page?: number;
  /** Server default 25, hard cap 200 (membersMaxPerPage). */
  per_page?: number;
}

/**
 * A partial list update. Every field optional, but the gateway requires at
 * least one — `minProperties: 1` in the surface spec.
 */
export interface UpdateListInput {
  name?: string;
  type?: CreateListInput["type"];
  optin?: CreateListInput["optin"];
  tags?: string[];
}

export class ListsResource extends Resource {
  list(): Promise<{ data?: { results?: List[] } } | List[]> {
    return this.client.request("GET", "/api/v1/lists");
  }

  create(input: CreateListInput): Promise<{ data?: List } | List> {
    return this.client.request("POST", "/api/v1/lists", { body: input });
  }

  /**
   * Update a list.
   *
   * The SDK could create and enumerate lists but not rename or re-configure
   * one, so an integration that made a typo had to reach past the SDK to fix
   * it. The operation has been in the curated surface spec (`updateList`) the
   * whole time — this is the gap a drift gate exists to surface.
   *
   * At least one field is required: the gateway rejects an empty patch rather
   * than treating it as a no-op, because a PATCH that changes nothing is
   * almost always a caller bug rather than an intent.
   */
  update(id: number | string, input: UpdateListInput): Promise<{ data?: List } | List> {
    return this.client.request(
      "PATCH",
      `/api/v1/lists/${encodeURIComponent(String(id))}`,
      { body: input },
    );
  }

  /**
   * The members of one list — the endpoint that actually filters by list.
   *
   * This is the correct home for the filter that used to be mis-declared as
   * `subscribers.list({ list_id })`: `GET /api/v1/subscribers` never reads a
   * list id, so that call returned the whole tenant. `GET /api/v1/lists/{id}/
   * subscribers` (apps/api/internal/lists/lists.go, `read:subscribers`) is
   * list-scoped in SQL and returns a `MembersPage`.
   *
   * `listId` accepts either a Moosewave UUID or a legacy Listmonk bigint; the
   * server resolves the bigint through `list_id_map` and 404s an unmapped one
   * rather than falling back to an unfiltered read.
   */
  members(
    listId: number | string,
    params: ListMembersParams = {},
  ): Promise<ListMembersPage> {
    const id = String(listId).trim();
    if (!id) throw new Error("List ID is required");
    const query: Record<string, string | number | undefined> = {};
    if (params.q !== undefined && params.q !== "") query.q = params.q;
    if (params.status !== undefined) query.status = params.status;
    if (params.page !== undefined) query.page = params.page;
    if (params.per_page !== undefined) query.per_page = params.per_page;
    return this.client.request(
      "GET",
      `/api/v1/lists/${encodeURIComponent(id)}/subscribers`,
      { query },
    );
  }

  /** Return the active lists to which a Moosewave subscriber belongs. */
  forSubscriber(
    subscriberId: string,
  ): Promise<{ items: SubscriberListReference[]; count: number }> {
    const id = subscriberId.trim();
    if (!id) throw new Error("Subscriber ID is required");
    return this.client.request(
      "GET",
      `/api/v1/lists/for-subscriber/${encodeURIComponent(id)}`,
    );
  }

  delete(id: number | string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/lists/${encodeURIComponent(String(id))}`,
    );
  }
}
