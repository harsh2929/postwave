// SPDX-License-Identifier: AGPL-3.0-only
//
// An in-memory stand-in for the audience API, for tests that mount several
// screens over ONE QueryClient and ask whether a write made on one screen
// reaches the others.
//
// State, not canned replies: every read is computed from the same lists,
// memberships and subscribers the writes change, so a screen that refetches
// shows the write and a screen that does not keeps showing what it cached.
// That is the behaviour under test — a stubbed reply that never changed could
// not tell a refetch from a stale cache.
//
// Response shapes follow the real services. List rows are the Listmonk v6.1.0
// row recorded by the cache diagnosis (POST /api/lists on a local v6.1.0
// engine), inside Listmonk's paginated `{data:{results,…}}` envelope that
// GET /api/v1/lists passes through, with the workspace `postwave_uuid` the
// gateway adds; member pages mirror lists.MembersPage and the per-subscriber
// view mirrors GET /api/v1/lists/for-subscriber/{id}.

export interface ServerList {
  id: number;
  postwaveUuid: string;
  name: string;
}

export interface ServerSubscriber {
  id: string;
  email: string;
}

interface Membership {
  listId: number;
  subscriberId: string;
  addedAt: string;
}

export class AudienceServer {
  lists: ServerList[];
  subscribers: ServerSubscriber[];
  memberships: Membership[] = [];
  /** "METHOD path" for every request that reached the server, in order. */
  requests: string[] = [];

  constructor(lists: ServerList[], subscribers: ServerSubscriber[]) {
    this.lists = lists;
    this.subscribers = subscribers;
  }

  private list(ref: string): ServerList {
    const found = this.lists.find(
      (l) => String(l.id) === ref || l.postwaveUuid === ref,
    );
    if (!found) throw notFound(`list ${ref}`);
    return found;
  }

  private membersOf(list: ServerList): Membership[] {
    return this.memberships.filter((m) => m.listId === list.id);
  }

  /** The Listmonk v6.1.0 list row, as GET /api/v1/lists passes it through. */
  private row(list: ServerList) {
    const count = this.membersOf(list).length;
    return {
      id: list.id,
      created_at: "2026-09-15T02:07:58.490396Z",
      updated_at: "2026-09-15T02:07:58.490396Z",
      uuid: `00000000-0000-4000-8000-${String(list.id).padStart(12, "0")}`,
      postwave_uuid: list.postwaveUuid,
      name: list.name,
      type: "private",
      optin: "single",
      status: "active",
      tags: [],
      description: "",
      subscriber_count: count,
      subscriber_statuses: count ? { unconfirmed: count } : {},
      subscription_created_at: null,
      subscription_updated_at: null,
    };
  }

  get = async (
    path: string,
    opts?: { query?: Record<string, unknown> },
  ): Promise<unknown> => {
    this.requests.push(`GET ${path}`);
    if (path === "/api/v1/lists") {
      const results = this.lists.map((l) => this.row(l));
      return {
        data: {
          results,
          query: "",
          total: results.length,
          per_page: 20,
          page: 1,
        },
      };
    }
    const members = /^\/api\/v1\/lists\/([^/]+)\/subscribers$/.exec(path);
    if (members) {
      const list = this.list(members[1]!);
      const page = Number(opts?.query?.page ?? 1);
      const perPage = Number(opts?.query?.per_page ?? 25);
      const all = this.membersOf(list);
      return {
        list_id: list.postwaveUuid,
        items: all.slice((page - 1) * perPage, page * perPage).map((m) => ({
          id: m.subscriberId,
          email: this.subscribers.find((s) => s.id === m.subscriberId)!.email,
          status: "unconfirmed",
          added_at: m.addedAt,
        })),
        total: all.length,
        page,
        per_page: perPage,
      };
    }
    const forSubscriber = /^\/api\/v1\/lists\/for-subscriber\/([^/]+)$/.exec(
      path,
    );
    if (forSubscriber) {
      const id = decodeURIComponent(forSubscriber[1]!);
      const items = this.memberships
        .filter((m) => m.subscriberId === id)
        .map((m) => {
          const list = this.lists.find((l) => l.id === m.listId)!;
          return { id: list.postwaveUuid, name: list.name };
        });
      return { subscriber_id: id, count: items.length, items };
    }
    if (path === "/api/v1/subscribers") {
      return {
        items: this.subscribers.map((s) => ({ ...s, status: "unconfirmed" })),
        total: this.subscribers.length,
        page: 1,
        per_page: 20,
      };
    }
    throw notFound(`GET ${path}`);
  };

  post = async (path: string, body?: unknown): Promise<unknown> => {
    this.requests.push(`POST ${path}`);
    const add = /^\/api\/v1\/lists\/([^/]+)\/subscribers$/.exec(path);
    if (add) {
      const list = this.list(add[1]!);
      let added = 0;
      let skipped = 0;
      for (const id of (body as { subscriber_ids: string[] }).subscriber_ids) {
        const known = this.subscribers.some((s) => s.id === id);
        const member = this.memberships.some(
          (m) => m.listId === list.id && m.subscriberId === id,
        );
        if (!known || member) {
          skipped += 1;
          continue;
        }
        this.memberships.push({
          listId: list.id,
          subscriberId: id,
          addedAt: "2026-09-15T03:00:00Z",
        });
        added += 1;
      }
      return { added, skipped };
    }
    throw notFound(`POST ${path}`);
  };

  delete = async (path: string): Promise<unknown> => {
    this.requests.push(`DELETE ${path}`);
    const remove = /^\/api\/v1\/lists\/([^/]+)\/subscribers\/([^/]+)$/.exec(
      path,
    );
    if (remove) {
      const list = this.list(remove[1]!);
      const id = decodeURIComponent(remove[2]!);
      this.memberships = this.memberships.filter(
        (m) => !(m.listId === list.id && m.subscriberId === id),
      );
      return undefined;
    }
    const list = /^\/api\/v1\/lists\/([^/]+)$/.exec(path);
    if (list) {
      const doomed = this.list(list[1]!);
      this.lists = this.lists.filter((l) => l.id !== doomed.id);
      this.memberships = this.memberships.filter(
        (m) => m.listId !== doomed.id,
      );
      return undefined;
    }
    throw notFound(`DELETE ${path}`);
  };
}

function notFound(what: string): Error {
  return Object.assign(new Error(`not found: ${what}`), { status: 404 });
}
