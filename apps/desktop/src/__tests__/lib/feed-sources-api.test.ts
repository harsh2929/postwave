import { describe, expect, it } from "vitest";

import {
  createFeedSourcesApi,
  type FeedSourcesRequester,
} from "../../lib/api/feed-sources";
import type { ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts:
    | {
        timeoutMs?: number;
        maxAttempts?: number;
        requireOnline?: boolean;
        signal?: AbortSignal;
      }
    | undefined;
}

function recordingRequester(
  responseFor: (path: string) => unknown = () => ({}),
): { calls: RequestCall[]; request: FeedSourcesRequester } {
  const calls: RequestCall[] = [];
  const request: FeedSourcesRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: RequestCall["opts"],
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: responseFor(path) as T };
  };
  return { calls, request };
}

describe("createFeedSourcesApi", () => {
  it("preserves CRUD routes, encoded identifiers, methods, and JSON bodies", async () => {
    const { calls, request } = recordingRequester();
    const api = createFeedSourcesApi(request);
    const createInput = {
      name: "Engineering",
      url: "https://example.test/feed.xml",
      schedule: "daily" as const,
      subject_template: "New: {{title}}",
      enabled: true,
    };

    await api.list();
    await api.create(createInput);
    await api.get("feed/one");
    await api.update("feed/one", { enabled: false });
    await api.remove("feed/one");

    expect(calls).toEqual([
      { path: "/api/v1/feed-sources", init: undefined, opts: undefined },
      {
        path: "/api/v1/feed-sources",
        init: { method: "POST", body: JSON.stringify(createInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/feed-sources/feed%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/feed-sources/feed%2Fone",
        init: { method: "PATCH", body: JSON.stringify({ enabled: false }) },
        opts: undefined,
      },
      {
        path: "/api/v1/feed-sources/feed%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("keeps manual polling online-only, single-attempt, and long-running", async () => {
    const failedPoll = {
      run_id: "run_1",
      status: "failed",
      items_seen: 0,
      new_items: 0,
      error: "feed returned 404",
    };
    const { calls, request } = recordingRequester((path) =>
      path.endsWith("/poll") ? failedPoll : { items: [] },
    );
    const api = createFeedSourcesApi(request);

    const result = await api.poll("feed/one");
    await api.listRuns("feed/one");

    expect(result).toEqual({ data: failedPoll });
    expect(calls).toEqual([
      {
        path: "/api/v1/feed-sources/feed%2Fone/poll",
        init: { method: "POST", body: "{}" },
        opts: {
          timeoutMs: 30_000,
          maxAttempts: 1,
          requireOnline: true,
        },
      },
      {
        path: "/api/v1/feed-sources/feed%2Fone/runs",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
