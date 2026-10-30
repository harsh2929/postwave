/**
 * lib/activeSend.ts — "is it going out RIGHT NOW?"
 *
 * The one question a phone is better placed to answer than a desk, and the one
 * the dashboard did not answer. A campaign mid-send rendered as an ordinary
 * row in "Recent campaigns": a title, a warning-toned pill reading "Sending",
 * and a date. No denominator, no progress, nothing pinned. Desktop keeps a
 * status strip in its chrome for exactly this state (ActiveSendStrip.tsx), so
 * the person AT the desk gets the alarm and the person away from it does not.
 *
 * ── THE POLL, AND THE STREAM ABOVE IT ──────────────────────────────────────
 * `/campaigns/{id}/report` is `session_minimum_role: "viewer"` on the routeauth
 * manifest and is polled at LIVE_SEND_POLL_MS by `useCampaignReport` while a
 * send is live. That poll is the FLOOR: it costs one request per ten seconds
 * for as long as a send is in flight, it needs no special credential, and it
 * is what this strip's numbers ultimately come from.
 *
 * There is also a live stream — GET /api/v1/campaigns/{id}/events, which
 * re-emits the whole CampaignReport every two seconds
 * (apps/api/internal/analytics/sse.go). This file used to say mobile could not
 * read it, on two grounds. One was simply wrong and the other was priced
 * wrongly:
 *
 *  1. "React Native's fetch has no streaming body." True of the GLOBAL fetch,
 *     which this app does not use for streams. `expo/fetch` is already a
 *     dependency, its `response.body` is a real `ReadableStream`, and
 *     `connectEventBus` has been reading one on every launch since before this
 *     comment was written. See api/sseConnect.
 *  2. "It is `exposure: credentialed`, so reaching it means minting a stream
 *     token — a whole credential lifecycle for a strip." The exposure claim is
 *     correct; the cost claim is not. That lifecycle already exists and already
 *     runs on every event-bus open (api/streamCredentials).
 *
 * So the stream is now opened ALONGSIDE the poll (hooks/useCampaignReportStream)
 * and writes into the same query cache entry. Nothing here branches on it: if
 * the stream never opens, this strip renders from the ten-second poll exactly
 * as it always did.
 *
 * ── WHAT THE STRIP IS ALLOWED TO CLAIM ─────────────────────────────────────
 * ABSENCE IS NOT ZERO, three times over:
 *  - No report yet ≠ nothing sent. It reads "waiting for the first delivery
 *    event", not "0 sent".
 *  - A FAILED report read is an error state, never a progress line: the
 *    caller passes `unavailable` and the strip says the progress could not be
 *    read rather than inventing a stalled send.
 *  - No audience total ≠ a 0% bar. Without a denominator there is no bar at
 *    all and the numerator is stated on its own.
 *
 * Pure and import-free of react-native so all of the above is unit-tested in
 * the node environment; the component only lays the strings out.
 */
import { isLiveSendStatus } from "@/lib/campaignProgress";
import { EMDASH, percent } from "@/lib/format";
import { msg, pluralMsg } from "@/lib/i18n";

/** The subset of a campaign list row the strip reads. */
export interface ActiveSendCandidate {
  id: string;
  name?: string | undefined;
  subject?: string | undefined;
  status?: string | undefined;
  /** 0..1 fractions, ABSENT (not 0) when the server reported none. */
  open_rate?: number | undefined;
  click_rate?: number | undefined;
}

export interface ActiveSendSelection<T extends ActiveSendCandidate> {
  /** The campaign the strip pins. */
  campaign: T;
  /** How many OTHER campaigns are also in flight. Usually 0. */
  others: number;
}

/**
 * Which campaign the strip pins.
 *
 * List order, not "most recently started": `GET /api/v1/campaigns` returns
 * newest-first and carries no per-send start timestamp, so ranking by
 * anything else would be an invention. When more than one send is running the
 * count is surfaced rather than hidden — a strip that silently picks one of
 * three is worse than no strip, because it reads as "one send is running".
 */
export function pickActiveSend<T extends ActiveSendCandidate>(
  campaigns: readonly T[] | null | undefined,
): ActiveSendSelection<T> | null {
  if (!campaigns || campaigns.length === 0) return null;
  const live = campaigns.filter((row) => isLiveSendStatus(row.status));
  const first = live[0];
  if (!first) return null;
  return { campaign: first, others: live.length - 1 };
}

export interface ActiveSendViewInput {
  name?: string | undefined;
  subject?: string | undefined;
  /** Other in-flight sends besides this one. */
  others?: number | undefined;
  /** `report.sent` — messages handed to the provider so far. */
  sent?: number | null | undefined;
  /** Audience size from the send-preview read, when it answered. */
  audience?: number | null | undefined;
  /** 0..1 fractions from the campaign list row. */
  openRate?: number | null | undefined;
  clickRate?: number | null | undefined;
  /** True when the progress read FAILED, as distinct from not having arrived. */
  unavailable?: boolean | undefined;
}

export interface ActiveSendView {
  /** Campaign subject, falling back to its name, then to a stated placeholder. */
  title: string;
  /** The progress line, in one of four honest shapes. */
  progress: string;
  /** 0..1 for the bar, or null when there is no denominator to draw against. */
  fraction: number | null;
  /** Compact visible rate line. Em-dash per rate the server did not report. */
  rates: string;
  /** "+2 more sending", or null when this is the only send in flight. */
  others: string | null;
  /** One whole spoken sentence for the pressable. */
  spoken: string;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function progressLine(
  sent: number | null,
  audience: number | null,
  unavailable: boolean,
): string {
  // A failed read is an error state, never a progress claim.
  if (unavailable) return msg("dashboard.activeSend.progress.unavailable");
  if (sent === null) return msg("dashboard.activeSend.progress.pending");
  if (audience === null || audience === 0) {
    return pluralMsg("dashboard.activeSend.progress.noTotal", sent);
  }
  return msg("dashboard.activeSend.progress.ofTotal", { sent, audience });
}

/** Everything the strip renders, decided in one place. */
export function activeSendView(input: ActiveSendViewInput): ActiveSendView {
  const title =
    input.subject?.trim() ||
    input.name?.trim() ||
    msg("dashboard.activeSend.untitled");
  const sent = count(input.sent);
  const audience = count(input.audience);
  const unavailable = input.unavailable === true;
  const progress = progressLine(sent, audience, unavailable);

  const fraction =
    !unavailable && sent !== null && audience !== null && audience > 0
      ? Math.max(0, Math.min(1, sent / audience))
      : null;

  const open = count(input.openRate);
  const click = count(input.clickRate);
  const rates = msg("dashboard.activeSend.rates", {
    open: open === null ? EMDASH : percent(open),
    click: click === null ? EMDASH : percent(click),
  });
  // A whole frame per shape. Dropping "click rate not reported" into a slot
  // that expects a percentage reads as "click rate not reported clicked": the
  // verb belongs to the frame, so the frame has to change with the fact.
  const spokenRates =
    open !== null && click !== null
      ? msg("dashboard.activeSend.rates.spoken", {
          open: percent(open),
          click: percent(click),
        })
      : open !== null
        ? msg("dashboard.activeSend.rates.spoken.noClick", {
            open: percent(open),
          })
        : click !== null
          ? msg("dashboard.activeSend.rates.spoken.noOpen", {
              click: percent(click),
            })
          : msg("dashboard.activeSend.rates.spoken.neither");

  const otherCount = count(input.others) ?? 0;
  const others =
    otherCount > 0 ? pluralMsg("dashboard.activeSend.others", otherCount) : null;

  // Two WHOLE frames rather than one frame plus an appended clause: a
  // translator has to be able to reorder "and N more are sending" relative to
  // the rest of the sentence, which string concatenation in here would freeze.
  const spoken =
    others === null
      ? msg("dashboard.activeSend.a11y", {
          title,
          progress,
          rates: spokenRates,
        })
      : msg("dashboard.activeSend.a11y.others", {
          title,
          progress,
          rates: spokenRates,
          others,
        });

  return { title, progress, fraction, rates, others, spoken };
}
