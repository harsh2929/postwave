import { describe, expect, it, vi } from "vitest";

import {
  buildMigrationJobItems,
  buildMigrationSourceItems,
} from "@/lib/migrationListItems";
import type { MobileMigrationJob, MobileMigrationSource } from "@/api/ops";

const job = (id: string) =>
  ({ id, source: "mailchimp", status: "running" }) as MobileMigrationJob;
const source = (name: string) =>
  ({ source: name }) as unknown as MobileMigrationSource;

const OFFLINE = {
  title: "Reconnect to load migrations",
  description: "Import jobs are read live from the server.",
};

const jobsInput = (over: Record<string, unknown> = {}) => ({
  rows: [] as MobileMigrationJob[],
  filteredRows: [] as MobileMigrationJob[],
  isLoading: false,
  isError: false,
  error: null,
  offline: null,
  onRetry: vi.fn(),
  onShowAll: vi.fn(),
  ...over,
});

describe("buildMigrationJobItems", () => {
  it("shows a skeleton on a first load and nothing else", () => {
    const items = buildMigrationJobItems(jobsInput({ isLoading: true }));
    expect(items.map((i) => i.kind)).toEqual(["loading"]);
  });

  it("puts an error ahead of empty — a failed fetch is never 'no jobs'", () => {
    const items = buildMigrationJobItems(
      jobsInput({ isError: true, error: new Error("boom") }),
    );
    expect(items[0]?.kind).toBe("error");
  });

  it("puts OFFLINE ahead of empty, and keeps it distinct from an error", () => {
    const items = buildMigrationJobItems(jobsInput({ offline: OFFLINE }));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind).toBe("empty");
    if (item.kind !== "empty") throw new Error("unreachable");
    expect(item.title).toBe("Reconnect to load migrations");
    // The sentence that caused the finding must not survive alongside it.
    expect(item.description).not.toContain("Start migrations from desktop");
  });

  it("prefers the ERROR rung when a request both failed and the gate is shut", () => {
    // Belt and braces: an errored query has genuinely spoken to the server, so
    // "you're offline" would be the wrong story.
    const items = buildMigrationJobItems(
      jobsInput({ isError: true, error: new Error("boom"), offline: OFFLINE }),
    );
    expect(items[0]?.kind).toBe("error");
  });

  it("keeps cached rows when a background poll fails", () => {
    const rows = [job("a")];
    const items = buildMigrationJobItems(
      jobsInput({
        rows,
        filteredRows: rows,
        isError: true,
        error: new Error("poll"),
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(["job"]);
  });

  it("keeps cached rows when the gate shuts under them", () => {
    const rows = [job("a")];
    const items = buildMigrationJobItems(
      jobsInput({ rows, filteredRows: rows, offline: OFFLINE }),
    );
    expect(items.map((i) => i.kind)).toEqual(["job"]);
  });

  it("says a genuine empty is empty", () => {
    const items = buildMigrationJobItems(jobsInput());
    const item = items[0]!;
    if (item.kind !== "empty") throw new Error("expected empty");
    expect(item.title).toBe("No migration jobs");
  });

  it("distinguishes a narrowed empty from an empty surface, with a way out", () => {
    const onShowAll = vi.fn();
    const items = buildMigrationJobItems(
      jobsInput({ rows: [job("a")], filteredRows: [], onShowAll }),
    );
    const item = items[0]!;
    if (item.kind !== "empty") throw new Error("expected empty");
    expect(item.title).toBe("No matching jobs");
    item.cta?.onPress();
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it("gives every item a stable, unique key", () => {
    const rows = [job("a"), job("b")];
    const items = buildMigrationJobItems(
      jobsInput({ rows, filteredRows: rows }),
    );
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["job-a", "job-b"]);
  });
});

describe("buildMigrationSourceItems", () => {
  const sourcesInput = (over: Record<string, unknown> = {}) => ({
    rows: [] as MobileMigrationSource[],
    isLoading: false,
    isError: false,
    error: null,
    offline: null,
    onRetry: vi.fn(),
    ...over,
  });

  it("reports offline rather than 'capabilities are unavailable'", () => {
    const items = buildMigrationSourceItems(
      sourcesInput({
        offline: {
          title: "Reconnect to load source coverage",
          description: "The matrix is read from the server.",
        },
      }),
    );
    const item = items[0]!;
    if (item.kind !== "empty") throw new Error("expected empty");
    expect(item.title).toBe("Reconnect to load source coverage");
    expect(item.description).not.toContain("unavailable");
  });

  it("still reports a genuine empty matrix as empty", () => {
    const items = buildMigrationSourceItems(sourcesInput());
    const item = items[0]!;
    if (item.kind !== "empty") throw new Error("expected empty");
    expect(item.title).toBe("No source matrix");
  });

  it("renders the matrix when it loaded", () => {
    const items = buildMigrationSourceItems(
      sourcesInput({ rows: [source("mailchimp"), source("klaviyo")] }),
    );
    expect(items.map((i) => i.key)).toEqual([
      "source-mailchimp",
      "source-klaviyo",
    ]);
  });
});
