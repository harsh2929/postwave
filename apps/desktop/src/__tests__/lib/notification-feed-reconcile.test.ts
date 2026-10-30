// Tests for reconciling desktop's local notification vault with the server feed.
//
// FIXTURES ARE DERIVED FROM THE REAL PRODUCERS, NOT INVENTED.
//
// The first version of this file used `kind: "approval.requested"` and
// `deep_link: "moosewave://approval/ap_1"` — describing a server that does not
// exist. Both were wrong in ways that made the module look correct while it
// could never match anything in production:
//
//   - the correlating field is `event_type`, not `kind`. `kind` is a
//     client-routing hint: for approvals it is `approval_request`
//     (event_billing_notification_adapters.go), while `event_type` carries the
//     canonical `approval.requested`;
//   - the server writes WEB paths (`/app/campaigns/<id>` —
//     sending/send_complete.go), never the `moosewave://` custom scheme the
//     local vault stores;
//   - two desktop topics are spelled differently from their server event type:
//     `dashboard.anomaly` → `analytics.anomaly`, `dashboard.milestone` →
//     `audience.milestone` (dashboardnotify.go).
//
// Seventeen tests passed against those fixtures while the feature was inert.
// Every value below is traceable to a named producer.

import { describe, expect, it } from "vitest";

import type { NotificationCenterEntry } from "../../lib/notification-center";
import {
  correlationKey,
  indexLocalEntries,
  indexServerItems,
  unifiedNotificationRows,
  readMarkersToPushUp,
  serverReadKeys,
  type ServerFeedItem,
} from "../../lib/notification-feed-reconcile";

/** A campaign-sent row exactly as notifyfanout writes it. */
const serverCampaign = (
  over: Partial<ServerFeedItem> = {},
): ServerFeedItem => ({
  id: "srv_1",
  kind: "campaign.sent",
  event_type: "campaign.sent",
  title: "Campaign sent: Spring promo", // server renders the record name
  body: "Delivery is complete.",
  deep_link: "/app/campaigns/cam_1", // WEB path, not moosewave://
  created_at: "2026-08-04T09:00:00Z",
  ...over,
});

/** The same notification as the vault stores it. */
const localCampaign = (
  over: Partial<NotificationCenterEntry> = {},
): NotificationCenterEntry => ({
  id: "loc_1",
  topic: "campaign.sent",
  category: "campaigns",
  title: "Campaign sent", // manifest copy — deliberately different
  body: "A campaign finished sending.",
  createdAt: "2026-08-04T09:00:00Z",
  deepLink: "moosewave://campaign/cam_1", // custom scheme, not a web path
  readAt: null,
  archivedAt: null,
  delivery: "delivered",
  ...over,
});

/** An approval row: LIST link + constant title, so it cannot be told apart. */
const serverApproval = (id: string): ServerFeedItem => ({
  id,
  kind: "approval_request",
  event_type: "approval.requested",
  title: "Approval needed",
  deep_link: "/app/approvals",
  created_at: "2026-08-04T09:00:00Z",
});

describe("correlationKey — against values the server really sends", () => {
  it("matches across the two link grammars and the diverging titles", () => {
    // The load-bearing test. Both sides address campaign cam_1; they spell the
    // link and the title differently, and only `event_type` (not `kind`)
    // carries the canonical type.
    const server = correlationKey.forServer(serverCampaign());
    const local = correlationKey.forLocal(localCampaign());
    expect(server?.key).toBe(local?.key);
    expect(server?.strong).toBe(true);
  });

  it("uses event_type, never kind", () => {
    const key = correlationKey.forServer(serverApproval("s"));
    expect(key?.key).toContain("approval.requested");
    expect(key?.key).not.toContain("approval_request");
  });

  it("translates the desktop-local dashboard topic names", () => {
    for (const [topic, eventType] of [
      ["dashboard.anomaly", "analytics.anomaly"],
      ["dashboard.milestone", "audience.milestone"],
    ] as const) {
      const local = correlationKey.forLocal(
        localCampaign({ topic, deepLink: null }),
      );
      expect(local?.key).toContain(eventType);
      expect(local?.key).not.toContain("dashboard.");
    }
  });

  it("cannot correlate a row with no event_type", () => {
    expect(
      correlationKey.forServer({
        id: "s",
        kind: "campaign.sent",
        title: "x",
        created_at: "2026-08-04T09:00:00Z",
      }),
    ).toBeNull();
  });

  it("marks a key WEAK when no entity can be recovered from either link", () => {
    // The server's approval link is the LIST route with a constant title, so
    // several approvals in one second are indistinguishable. The key degrades
    // to type+timestamp and is flagged rather than trusted.
    expect(correlationKey.forServer(serverApproval("s"))?.strong).toBe(false);
  });
});

describe("ambiguity is refused, never guessed", () => {
  it("drops weak keys from both indexes", () => {
    expect(
      indexServerItems([serverApproval("a"), serverApproval("b")]).size,
    ).toBe(0);
    expect(indexLocalEntries([localCampaign({ deepLink: null })]).size).toBe(0);
  });

  it("one local read never marks N server rows read", () => {
    // The hazard this module exists to refuse: three approvals in the same
    // second share a link and a title, so a single local read must not fan out
    // and silently clear notifications the user never opened.
    const ids = readMarkersToPushUp({
      server: [serverApproval("a"), serverApproval("b"), serverApproval("c")],
      local: [
        localCampaign({
          topic: "approval.requested",
          deepLink: null,
          readAt: "2026-08-04T09:05:00Z",
        }),
      ],
    });
    expect(ids).toEqual([]);
  });

  it("drops a strong key claimed by two records on the same side", () => {
    expect(
      indexServerItems([serverCampaign(), serverCampaign({ id: "srv_2" })])
        .size,
    ).toBe(0);
  });
});

describe("readMarkersToPushUp — the cutover", () => {
  it("pushes a locally-read item the server still thinks is unread", () => {
    expect(
      readMarkersToPushUp({
        server: [serverCampaign()],
        local: [localCampaign({ readAt: "2026-08-04T09:05:00Z" })],
      }),
    ).toEqual(["srv_1"]);
  });

  it("never pushes something the user did not read", () => {
    expect(
      readMarkersToPushUp({
        server: [serverCampaign()],
        local: [localCampaign()],
      }),
    ).toEqual([]);
  });

  it("is idempotent — a second pass after the push sends nothing", () => {
    const local = [localCampaign({ readAt: "2026-08-04T09:05:00Z" })];
    expect(readMarkersToPushUp({ server: [serverCampaign()], local })).toEqual([
      "srv_1",
    ]);
    expect(
      readMarkersToPushUp({
        server: [serverCampaign({ read_at: "2026-08-04T09:05:00Z" })],
        local,
      }),
    ).toEqual([]);
  });

  it("ignores a local entry the server never issued", () => {
    expect(
      readMarkersToPushUp({
        server: [],
        local: [localCampaign({ readAt: "2026-08-04T09:05:00Z" })],
      }),
    ).toEqual([]);
  });
});

describe("serverReadKeys — the pull", () => {
  it("returns only unambiguous keys the server considers read", () => {
    const keys = serverReadKeys([
      serverCampaign({ read_at: "2026-08-04T09:01:00Z" }),
      serverCampaign({ id: "srv_2", deep_link: "/app/campaigns/cam_2" }),
    ]);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toContain("campaign/cam_1");
  });

  it("excludes ambiguous rows even when they are read", () => {
    expect(
      serverReadKeys([
        { ...serverApproval("a"), read_at: "2026-08-04T09:01:00Z" },
        { ...serverApproval("b"), read_at: "2026-08-04T09:01:00Z" },
      ]).size,
    ).toBe(0);
  });
});

describe("unifiedNotificationRows — what the bell actually renders", () => {
  it("annotates a correlated pair: SERVER read state, LOCAL delivery + archive", () => {
    const [row] = unifiedNotificationRows({
      server: [serverCampaign({ read_at: "2026-08-04T09:01:00Z" })],
      local: [
        localCampaign({
          readAt: null,
          delivery: "suppressed-quiet-hours",
          archivedAt: "2026-08-04T09:30:00Z",
        }),
      ],
    });
    expect(row.source).toBe("both");
    expect(row.readAt).toBe("2026-08-04T09:01:00Z"); // server wins
    expect(row.delivery).toBe("suppressed-quiet-hours"); // local only
    expect(row.archivedAt).toBe("2026-08-04T09:30:00Z"); // local only
    expect(row.localId).toBe("loc_1");
    expect(row.serverId).toBe("srv_1");
  });

  it("KEEPS a local-only entry — pre-cutover history must not vanish", () => {
    // The strict server-authority view dropped these. Applied to the panel that
    // would silently delete visible history the moment the feed loaded, which
    // is a worse bug than the one it fixes.
    const [row] = unifiedNotificationRows({
      server: [],
      local: [localCampaign()],
    });
    expect(row.source).toBe("local");
    expect(row.serverId).toBeNull();
    expect(row.localId).toBe("loc_1");
  });

  it("includes a server-only row raised on ANOTHER device", () => {
    // The entire point: a notification this machine never delivered still
    // belongs in the bell.
    const [row] = unifiedNotificationRows({
      server: [serverCampaign()],
      local: [],
    });
    expect(row.source).toBe("server");
    expect(row.localId).toBeNull();
    expect(row.delivery).toBe("unknown");
    expect(row.archivedAt).toBeNull();
  });

  it("never renders a correlated notification twice", () => {
    const rows = unifiedNotificationRows({
      server: [serverCampaign()],
      local: [localCampaign()],
    });
    expect(rows).toHaveLength(1);
  });

  it("keys weak-correlation rows separately rather than merging them", () => {
    // Three approvals in one second are indistinguishable, so they must render
    // as three rows, not collapse into one.
    const rows = unifiedNotificationRows({
      server: [serverApproval("a"), serverApproval("b")],
      local: [
        localCampaign({
          id: "loc_ap",
          topic: "approval.requested",
          deepLink: null,
          title: "Approval needed",
        }),
      ],
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
  });

  it("orders newest first and sorts unparseable timestamps last", () => {
    const rows = unifiedNotificationRows({
      server: [
        serverCampaign({
          id: "bad",
          created_at: "nope",
          deep_link: "/app/campaigns/c3",
        }),
        serverCampaign({
          id: "old",
          created_at: "2026-08-04T08:00:00Z",
          deep_link: "/app/campaigns/c1",
        }),
        serverCampaign({
          id: "new",
          created_at: "2026-08-04T10:00:00Z",
          deep_link: "/app/campaigns/c2",
        }),
      ],
      local: [],
    });
    expect(rows.map((r) => r.serverId)).toEqual(["new", "old", "bad"]);
  });

  it("carries the canonical event type from whichever side has it", () => {
    expect(
      unifiedNotificationRows({ server: [serverApproval("a")], local: [] })[0]
        .eventType,
    ).toBe("approval.requested");
    expect(
      unifiedNotificationRows({ server: [], local: [localCampaign()] })[0]
        .eventType,
    ).toBe("campaign.sent");
  });
});

describe("read state on a correlated row", () => {
  it("clears from EITHER side — opening a row must not leave it bold", () => {
    // The click marks the VAULT. `lastFeed` still says unread until the next
    // sync, so a server-only read source left the row bold and kept it in the
    // unread count after the user had plainly read it. Read is monotonic, so
    // honouring either marker cannot un-read anything.
    const [row] = unifiedNotificationRows({
      server: [serverCampaign()], // no read_at
      local: [localCampaign({ readAt: "2026-08-04T09:05:00Z" })],
    });
    expect(row.source).toBe("both");
    expect(row.readAt).toBe("2026-08-04T09:05:00Z");
  });

  it("still prefers the server marker when both exist", () => {
    const [row] = unifiedNotificationRows({
      server: [serverCampaign({ read_at: "2026-08-04T09:01:00Z" })],
      local: [localCampaign({ readAt: "2026-08-04T09:05:00Z" })],
    });
    expect(row.readAt).toBe("2026-08-04T09:01:00Z");
  });
});

describe("duplicate strong keys cannot produce duplicate render keys", () => {
  it("refuses to let two server rows consume the same local entry", () => {
    // Two server rows sharing one STRONG key are ambiguous. If both correlated
    // to the same local entry they would emit the same React key, and React
    // would drop one row silently.
    const rows = unifiedNotificationRows({
      server: [
        serverCampaign({ id: "srv_a" }),
        serverCampaign({ id: "srv_b" }),
      ],
      local: [localCampaign()],
    });
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The local entry is not consumed by either, so it renders on its own.
    expect(rows.filter((r) => r.source === "local")).toHaveLength(1);
  });
});
