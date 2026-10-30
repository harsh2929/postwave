/**
 * CampaignActivityFeed — collapsible "Activity" section embedded in the
 * campaign detail slideover. Subscribes to `campaign.*`, `approval.*`
 * and `audit.created` topics on the shared event-bus, filters them down
 * to events that mention this campaign (via payload.id, campaign_id, or
 * resource_id), and renders the most recent 20 in a vertical timeline.
 *
 * Design notes
 * ------------
 * - Back-filled on mount from `api.listAudit({resourceType:"campaign",
 *   resourceId})`, then kept live by the bus. The original note here said
 *   back-fill "would need a paginated `/api/v1/audit?resource=...`" — that
 *   endpoint already existed and already took `resource_type` + `resource_id`,
 *   so the panel opened blank on every campaign that had not changed since the
 *   slideover was opened, and looked like a feature that did not work.
 * - Events arrive newest-last on the wire, but the UI shows newest-first
 *   so we prepend and cap to RING_CAP.
 * - When the bus is `closed`, header shows "Reconnecting…" so a stale
 *   panel can't masquerade as an idle one.
 * - Visual style mirrors Dashboard.tsx's "What's happening" card: small
 *   typography, muted timestamps via `--pw-fg-muted`, row separators via
 *   `--pw-border-soft`, numeric/time text uses `.tabular`.
 */

import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api } from "../lib/api-client";
import { type EventBusMessage, useEventBus } from "../lib/event-bus";
import { pickAuditRows } from "../pages/audit/audit-page-utils";
import {
  type FeedEntry,
  RING_CAP,
  asString,
  auditRowsToEntries,
  dedupeKeyForEvent,
  mergeBackfillEntries,
  payloadCampaignId,
} from "./campaign-activity-feed-helpers";
import { prettyAction } from "./notifications-panel-helpers";

interface Props {
  campaignId: string | number;
}

/** Topics whose payloads we care about. */
const TOPIC_FILTERS = ["campaign.*", "approval.*", "audit.created"] as const;

function describe(
  topic: string,
  payload: Record<string, unknown> | undefined,
): string {
  const p = payload ?? {};
  switch (topic) {
    case "campaign.created":
      return "Campaign created";
    case "campaign.updated": {
      const f = asString(p.field);
      if (f) return `${f.charAt(0).toUpperCase() + f.slice(1)} changed`;
      return "Campaign updated";
    }
    case "campaign.sent": {
      const recips = p.recipients;
      if (typeof recips === "number")
        return `Sent to ${recips.toLocaleString()} recipients`;
      return "Campaign sent";
    }
    case "approval.requested":
      return "Approval requested";
    case "approval.decided": {
      const dec = asString(p.decision).toLowerCase();
      if (dec === "approved") return "Approval approved";
      if (dec === "rejected") return "Approval rejected";
      return "Approval decided";
    }
    case "audit.created": {
      const action = asString(p.action);
      const desc = asString(p.description);
      return desc || (action ? `Audit: ${action}` : "Audit event");
    }
    default:
      return topic;
  }
}

function pickActor(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "system";
  return (
    asString(payload.actor) ||
    asString(payload.actor_label) ||
    asString(payload.requested_by) ||
    asString(payload.user) ||
    "system"
  );
}

function relativeTime(at: string, now: number): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  const diffMs = now - t;
  const sec = Math.max(0, Math.round(diffMs / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  return `${wk}w ago`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function CampaignActivityFeed({ campaignId }: Props): ReactElement {
  const bus = useEventBus();
  const [open, setOpen] = useState(true);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  // Re-render every 30s so relative timestamps stay fresh while the
  // panel is open. Pure cosmetic — no event traffic needed.
  const [tick, setTick] = useState(0);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const targetId = useMemo<string | null>(() => {
    if (campaignId == null) return null;
    return String(campaignId);
  }, [campaignId]);

  // Back-fill before subscribing.
  //
  // The bus is live-only, so without this the panel is empty on open and fills
  // in solely if something happens while you watch — which reads as broken on
  // any campaign with real history.
  //
  // The merge de-duplicates WITHIN each source, not across them. The comment
  // that used to sit here claimed an in-flight bus event "is not shown twice";
  // that was never true and could not have been — see `dedupeKeyForAuditRow`
  // for the two independent reasons, and for the upstream change that would
  // make it true.
  useEffect(() => {
    if (targetId == null) return;
    // Drop the PREVIOUS campaign's rows first.
    //
    // The slideover is reused: opening it on another campaign changes
    // `targetId` without unmounting, so `entries` still holds the last
    // campaign's history and `mergeBackfillEntries` merges the new campaign's
    // audit rows into it. The panel then attributes one campaign's activity to
    // another — not a stale render that corrects itself, but a wrong answer
    // that persists for as long as the panel stays open.
    //
    // Synchronous, before the await: this effect runs before the bus effect
    // re-subscribes, so there is no window in which a new-target event is
    // cleared by it.
    setEntries([]);
    let cancelled = false;
    void (async () => {
      const res = await api.listAudit({
        resourceType: "campaign",
        resourceId: targetId,
        limit: RING_CAP,
      });
      // Matches how src/pages/audit/useAuditData.ts reads this call: the
      // result carries `error`, not `ok`. A failed back-fill is silent on
      // purpose — the live bus still works, and an error banner on a
      // collapsible side panel would be louder than the loss.
      if (cancelled || res.error) return;
      const rows = pickAuditRows(res.data).rows;
      const backfilled = auditRowsToEntries(rows, (row) => prettyAction(row));
      setEntries((prev) => mergeBackfillEntries(prev, backfilled));
    })();
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  // Bus subscription — one handler per topic family. We lean on
  // useEventBus().subscribe directly (rather than useEventSubscription)
  // because we attach to three patterns and want them to share state
  // without three independent ring buffers.
  useEffect(() => {
    if (targetId == null) return;
    const handler = (evt: EventBusMessage<Record<string, unknown>>): void => {
      const id = payloadCampaignId(evt.topic, evt.payload);
      if (id == null) return;
      if (String(id) !== targetId) return;
      seqRef.current += 1;
      const entry: FeedEntry = {
        key: `${evt.topic}:${evt.at}:${seqRef.current}`,
        topic: evt.topic,
        at: evt.at,
        actor: pickActor(evt.payload),
        description: describe(evt.topic, evt.payload),
        // Identity within the LIVE stream only. It deliberately does not match
        // a back-filled row for the same happening — see dedupeKeyForAuditRow.
        dedupeKey: dedupeKeyForEvent(evt.topic, evt.at),
      };
      setEntries((prev) => {
        const next = [entry, ...prev];
        if (next.length > RING_CAP) next.length = RING_CAP;
        return next;
      });
    };
    const unsubs = TOPIC_FILTERS.map((t) =>
      bus.subscribe<Record<string, unknown>>(t, handler),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [bus, targetId]);

  // Auto-scroll to top when a new event arrives.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = 0;
  }, [entries, open]);

  // Tick relative timestamps every 30s.
  useEffect(() => {
    if (!open || entries.length === 0) return;
    const id = window.setInterval(() => {
      setTick((n) => n + 1);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [entries.length, open]);
  // Acknowledge the tick so it isn't flagged as unused — the value is
  // intentionally only consumed via re-render side effect.
  void tick;

  const reconnecting = bus.status === "closed";
  const now = Date.now();

  return (
    <div className="campaign-activity">
      <button
        type="button"
        className="campaign-activity-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="campaign-activity-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="label" style={{ marginBottom: 0 }}>
          Activity
        </span>
        {entries.length > 0 ? (
          <span className="campaign-activity-count tabular">
            {entries.length}
          </span>
        ) : null}
        {reconnecting ? (
          <span className="campaign-activity-reconnect">Reconnecting…</span>
        ) : null}
      </button>
      {open ? (
        <div className="campaign-activity-list" ref={listRef}>
          {entries.length === 0 ? (
            <div className="campaign-activity-empty">No activity yet.</div>
          ) : (
            entries.map((e) => (
              <div key={e.key} className="campaign-activity-row">
                <div className="campaign-activity-row-main">
                  <span className="muted">{e.actor}</span>{" "}
                  <span>{e.description}</span>
                </div>
                <div className="campaign-activity-row-time muted tabular">
                  {relativeTime(e.at, now)}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
