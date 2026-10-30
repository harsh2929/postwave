import { readFileSync, readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Subscriber } from "../../lib/api-client";
import {
  buildSubscribersCsv,
  encodeSubscribersCsvCell,
  getSubscribersSubtitle,
  isSubscribersLiveEligible,
  mergeBufferedSubscribers,
  resolveSubscribersExportSort,
  savedSegmentSnapshot,
  subscriberKey,
} from "../../pages/subscribers/subscribers-page-utils";

function subscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id: overrides.id ?? "subscriber-1",
    email: overrides.email ?? "alice@example.test",
    status: overrides.status ?? "enabled",
    ...overrides,
  } as Subscriber;
}

describe("subscribers page controller boundaries", () => {
  it("uses stable row keys and produces escaped CSV without changing columns", () => {
    expect(subscriberKey(subscriber({ id: 42 }))).toBe("42");
    expect(
      subscriberKey(subscriber({ id: undefined, email: "fallback@test" })),
    ).toBe("fallback@test");
    expect(subscriberKey({} as Subscriber)).toBe("");

    expect(
      buildSubscribersCsv([
        subscriber({
          email: 'alice,"ops"@example.test',
          created_at: "2026-07-15T10:00:00Z",
          joined_at: "2026-07-16T10:00:00Z",
          tags: ["customer", "weekly"],
        }),
      ]),
    ).toBe(
      'email,status,created_at,joined_at,tags\n"alice,""ops""@example.test",enabled,2026-07-15T10:00:00Z,2026-07-16T10:00:00Z,customer|weekly',
    );
  });

  it("neutralizes formulas after whitespace or hidden controls and visibly escapes controls", () => {
    const dangerous = [
      ["=1+1", "'=1+1"],
      [" +SUM(1,2)", `"' +SUM(1,2)"`],
      ["\t@cmd", "'\t@cmd"],
      ["\n-42", `"'\n-42"`],
      [
        '\r=HYPERLINK("https://evil.test")',
        `"'\r=HYPERLINK(""https://evil.test"")"`,
      ],
      ["\u0000=cmd", "'\\u0000=cmd"],
      ["\u202E+cmd", "'\\u202E+cmd"],
      ["\uFEFF@cmd", "'\\uFEFF@cmd"],
      ["\u00A0-cmd", "'\u00A0-cmd"],
    ] as const;
    for (const [value, expected] of dangerous) {
      expect(encodeSubscribersCsvCell(value)).toBe(expected);
    }
    expect(encodeSubscribersCsvCell("safe\u0007value")).toBe(
      "safe\\u0007value",
    );
    expect(encodeSubscribersCsvCell('safe,"quoted"\r\nvalue')).toBe(
      '"safe,""quoted""\r\nvalue"',
    );
  });

  it("only resolves sorts that the server can apply to the complete result", () => {
    expect(resolveSubscribersExportSort("updated_at")).toBe("updated_at");
    expect(resolveSubscribersExportSort("joined")).toBe("created_at");
    expect(resolveSubscribersExportSort("churn_score")).toBe("churn");
    expect(resolveSubscribersExportSort("full_name")).toBeNull();
  });

  it("keeps loading, unfiltered-total, and filtered-match subtitles honest", () => {
    const base = {
      filter: "all" as const,
      query: "",
      serverTotal: 12_345,
      matchTotal: 3,
      pageRowCount: 2,
    };
    expect(getSubscribersSubtitle({ ...base, rows: null })).toBe(
      "Loading subscribers…",
    );
    expect(getSubscribersSubtitle({ ...base, rows: [] })).toBe(
      "12,345 contacts in this workspace.",
    );
    expect(
      getSubscribersSubtitle({
        ...base,
        rows: [subscriber()],
        serverTotal: 1,
      }),
    ).toBe("1 contact in this workspace.");
    expect(
      getSubscribersSubtitle({
        ...base,
        rows: [subscriber()],
        filter: "subscribed",
        serverTotal: null,
        matchTotal: 1,
      }),
    ).toBe("1 contact matching this view.");
    expect(
      getSubscribersSubtitle({
        ...base,
        rows: [subscriber(), subscriber({ id: "subscriber-2" })],
        query: "alice",
        serverTotal: null,
        matchTotal: null,
      }),
    ).toBe("2 contacts matching this view.");
  });

  it("only enables prepend-style live updates for the untouched first page", () => {
    const eligible = {
      filter: "all" as const,
      debouncedQuery: "",
      page: 1,
      sortColumn: "updated_at",
      sortOrder: "desc",
      showArchived: false,
    };
    expect(isSubscribersLiveEligible(eligible)).toBe(true);
    expect(
      isSubscribersLiveEligible({ ...eligible, filter: "subscribed" }),
    ).toBe(false);
    expect(
      isSubscribersLiveEligible({ ...eligible, debouncedQuery: "alice" }),
    ).toBe(false);
    expect(isSubscribersLiveEligible({ ...eligible, page: 2 })).toBe(false);
    expect(
      isSubscribersLiveEligible({ ...eligible, sortColumn: "email" }),
    ).toBe(false);
    expect(isSubscribersLiveEligible({ ...eligible, sortOrder: "asc" })).toBe(
      false,
    );
    expect(isSubscribersLiveEligible({ ...eligible, showArchived: true })).toBe(
      false,
    );
  });

  it("prepends only unseen buffered subscribers in buffer order", () => {
    const existing = [
      subscriber({ id: "two", email: "two@example.test" }),
      subscriber({ id: "one", email: "one@example.test" }),
    ];
    const merged = mergeBufferedSubscribers(
      [
        subscriber({ id: "three", email: "three@example.test" }),
        subscriber({ id: "two", email: "new-two@example.test" }),
      ],
      existing,
    );
    expect(merged.map(subscriberKey)).toEqual(["three", "two", "one"]);
    expect(
      mergeBufferedSubscribers([subscriber({ id: "fresh" })], null).map(
        subscriberKey,
      ),
    ).toEqual(["fresh"]);
  });

  it("reads complete and legacy saved-view snapshots with exact precedence", () => {
    expect(
      savedSegmentSnapshot({
        filters: { status: "subscribed", q: "current" },
        snapshot: {
          version: 2,
          status: "unsubscribed",
          q: "reviewed",
          show_archived: true,
          sort_column: "email",
          sort_order: "asc",
          columns: ["email", "status", 42],
        },
        status: "disabled",
        q: "flat",
      }),
    ).toEqual({
      status: "unsubscribed",
      query: "reviewed",
      version: 2,
      authoritative: false,
      resourceScope: undefined,
      workspaceScope: undefined,
      showArchived: true,
      sortColumn: "email",
      sortOrder: "asc",
      columns: ["email", "status"],
    });
    expect(
      savedSegmentSnapshot({ snapshot: { status: "unsubscribed", q: 42 } }),
    ).toEqual({
      status: "unsubscribed",
      query: undefined,
      version: undefined,
      authoritative: false,
      resourceScope: undefined,
      workspaceScope: undefined,
      showArchived: undefined,
      sortColumn: undefined,
      sortOrder: undefined,
      columns: undefined,
    });
    expect(savedSegmentSnapshot({ status: "all", q: "flat" })).toEqual({
      status: "all",
      query: "flat",
      version: undefined,
      authoritative: false,
      resourceScope: undefined,
      workspaceScope: undefined,
      showArchived: undefined,
      sortColumn: undefined,
      sortOrder: undefined,
      columns: undefined,
    });
    expect(
      savedSegmentSnapshot({
        snapshot: {
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "reviewed",
          status: "subscribed",
          include_archived: true,
          sort: { column: "email", order: "asc" },
          columns: ["email", "status"],
          reset: { page: 1, selection: "clear" },
        },
      }),
    ).toEqual({
      status: "subscribed",
      query: "reviewed",
      version: 3,
      authoritative: true,
      resourceScope: "subscriber_directory",
      workspaceScope: "current",
      showArchived: true,
      sortColumn: "email",
      sortOrder: "asc",
      columns: ["email", "status"],
    });
    expect(
      savedSegmentSnapshot({
        snapshot: {
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "reviewed",
          status: "subscribed",
          include_archived: true,
          sort: { column: "email", order: "asc" },
          columns: ["email", 42],
        },
      })?.authoritative,
    ).toBe(false);
    const damagedV3 = savedSegmentSnapshot({
      filters: { status: "subscribed", q: "must-not-fallback" },
      snapshot: {
        version: 3,
        resource_scope: "subscriber_directory",
        workspace_scope: "current",
        applied_query: "authoritative-query",
        include_archived: false,
        sort: { column: "email", order: "asc" },
        columns: ["email"],
        reset: { page: 1, selection: "clear" },
      },
    });
    expect(damagedV3).toMatchObject({
      status: undefined,
      query: "authoritative-query",
      version: 3,
      authoritative: false,
    });
    expect(
      savedSegmentSnapshot({
        snapshot: {
          version: 4,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "future",
          status: "subscribed",
          include_archived: false,
          sort: { column: "email", order: "asc" },
          columns: ["email"],
          reset: { page: 1, selection: "clear" },
        },
      })?.authoritative,
    ).toBe(false);
    expect(savedSegmentSnapshot({ and: [{ field: "status" }] })).toBeNull();
    expect(savedSegmentSnapshot(null)).toBeNull();
  });

  it("rejects saved-view queries that cannot round-trip through directory state", () => {
    const snapshot = (query: string) =>
      savedSegmentSnapshot({
        snapshot: {
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: query,
          status: "all",
          include_archived: false,
          sort: { column: "updated_at", order: "desc" },
          columns: ["email"],
          reset: { page: 1, selection: "clear" },
        },
      });

    expect(snapshot("a".repeat(256))?.authoritative).toBe(true);
    expect(snapshot("a".repeat(257))?.query).toBeUndefined();
    expect(snapshot("status:enabled\nstatus:disabled")?.query).toBeUndefined();
    expect(snapshot(" padded ")?.query).toBeUndefined();

    const invalidShape = (overrides: Record<string, unknown>) =>
      savedSegmentSnapshot({
        snapshot: {
          version: 3,
          resource_scope: "subscriber_directory",
          workspace_scope: "current",
          applied_query: "",
          status: "all",
          include_archived: false,
          sort: { column: "updated_at", order: "desc" },
          columns: ["email"],
          reset: { page: 1, selection: "clear" },
          ...overrides,
        },
      });
    expect(invalidShape({ status: "future-status" })?.authoritative).toBe(
      false,
    );
    expect(
      invalidShape({ sort: { column: "future-sort", order: "asc" } })
        ?.authoritative,
    ).toBe(false);
    expect(
      invalidShape({ columns: ["email", "unknown-column"] })?.authoritative,
    ).toBe(false);
  });

  it("keeps export and history privacy boundaries fail closed", () => {
    const exporter = readFileSync(
      new URL(
        "../../pages/subscribers/useSubscribersExport.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const detail = readFileSync(
      new URL(
        "../../components/subscribers/SubscriberDetailPresentation.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(exporter).not.toContain("buildSubscribersCsv(");
    expect(exporter).not.toContain("pageRows.slice(");
    expect(exporter).toContain("No page-only fallback was saved");
    expect(detail).not.toContain("JSON.stringify(event.payload)");
    expect(detail).toContain("subscriberHistoryDisplay(event)");
  });

  it("keeps Subscribers as a thin shell and every extracted module below 300 lines", () => {
    const page = readFileSync(
      new URL("../../pages/Subscribers.tsx", import.meta.url),
      "utf8",
    );
    expect(page).toContain("useSubscribersPageController");
    expect(page).toContain("SubscribersPagePresentation");
    expect(page).not.toContain("useState(");
    expect(page).not.toContain("api.");

    const directory = new URL("../../pages/subscribers/", import.meta.url);
    for (const filename of readdirSync(directory)) {
      const file = new URL(filename, directory);
      if (!statSync(file).isFile() || !/\.[jt]sx?$/.test(filename)) continue;
      const lines = readFileSync(file, "utf8").split("\n").length;
      expect(lines, filename).toBeLessThanOrEqual(300);
    }

    const budgets = readFileSync(
      new URL(
        "../../../scripts/function-quality-budgets.json",
        import.meta.url,
      ),
      "utf8",
    );
    expect(budgets).not.toContain('"src/pages/Subscribers.tsx"');
  });
});
