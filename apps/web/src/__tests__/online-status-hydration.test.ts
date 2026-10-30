// SPDX-License-Identifier: AGPL-3.0-only
//
// /app threw a hydration mismatch on every load. React's diff named the exact
// attributes:
//
//   + disabled={false}                        (client)
//   - disabled=""                             (server)
//   + aria-describedby={undefined}            (client)
//   - aria-describedby="…H1_"                 (server)
//   - <p id="…H1_">                           (server only)
//
// on the LayoutCustomizer trigger. That button is disabled by
//
//   layoutDisabled = !identityReady || viewerMode || online !== "online"
//
// and `online` comes from `useOnline()`, which is a `useSyncExternalStore` —
// passing `getOnlineStatus` as the getServerSnapshot argument as well as the
// client one:
//
//   useSyncExternalStore(subscribeOnlineStatus, getOnlineStatus, getOnlineStatus)
//
// `online-manager` holds `status` in a module-level variable seeded to
// "connecting". During SSR nothing starts the heartbeat, so the server renders
// "connecting" — button disabled, explanation paragraph present. By the time
// the browser hydrates, the manager has already flipped to "online", and
// because the SAME getter serves as the server snapshot, React's hydration pass
// reads the live value and finds markup that disagrees with the HTML it was
// given.
//
// The contract `useSyncExternalStore` expects is that getServerSnapshot returns
// what the SERVER rendered, so the hydration pass reproduces the server HTML
// and React updates to the live value on the next render — no mismatch, no
// discarded tree.
import { describe, expect, it } from "vitest";

import {
  SSR_ONLINE_STATUS,
  getOnlineStatus,
  getServerOnlineStatus,
  setOnlineStatusForTest,
} from "@/lib/online-manager";

describe("online status has a stable server snapshot", () => {
  it("the server snapshot is the value SSR actually renders with", () => {
    // Nothing starts the heartbeat during SSR, so the module's seed value is
    // what the server HTML was built from.
    expect(SSR_ONLINE_STATUS).toBe("connecting");
    expect(getServerOnlineStatus()).toBe(SSR_ONLINE_STATUS);
  });

  it("stays fixed even after the live status has moved on", () => {
    // This is the whole defect: the live getter had already become "online" by
    // hydration time. The server snapshot must not follow it.
    setOnlineStatusForTest("online");
    expect(getOnlineStatus()).toBe("online");
    expect(getServerOnlineStatus()).toBe("connecting");

    setOnlineStatusForTest("offline");
    expect(getServerOnlineStatus()).toBe("connecting");

    setOnlineStatusForTest("connecting");
  });
});

describe("useOnline wires a distinct server snapshot", () => {
  it("does not pass the live getter as getServerSnapshot", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/use-online.ts"),
      "utf8",
    );
    // Assert the SHAPE of the call, not how many times a name appears. A
    // count-based assertion failed here on the doc comment that explains the
    // bug — the same prose-versus-code trap as matching a path in a comment.
    const call = source.match(
      /useSyncExternalStore\(\s*([A-Za-z0-9_]+),\s*([A-Za-z0-9_]+),\s*([A-Za-z0-9_]+),?\s*\)/,
    );
    expect(call, "useOnline must call useSyncExternalStore with 3 arguments").not.toBeNull();
    const [, subscribe, client, server] = call!;
    expect(subscribe).toBe("subscribeOnlineStatus");
    expect(client).toBe("getOnlineStatus");
    // The defect in one line: the server slot held the client getter.
    expect(server).toBe("getServerOnlineStatus");
    expect(server).not.toBe(client);
  });
});
