/**
 * lib/privacyIncidentCopy.ts — turning incident wire values into the sentences
 * this surface says out loud.
 *
 * Split from `privacyIncidentPolicy` because it is a different kind of
 * decision: the policy module answers "what may happen and when", this one
 * answers "what do we call it". Keeping them apart is also what keeps both
 * under the source budget as the vocabulary grows.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: state is never colour alone. Every
 * tone returned here is accompanied by a word, and every compacted or absent
 * value has a spoken form beside it.
 *
 * DELIBERATELY IMPORT-FREE apart from sibling pure modules.
 */
import { transitionLabel } from "@/lib/direction";
import { EMDASH, num } from "@/lib/format";
import {
  INCIDENT_STATE_LABEL,
  type IncidentTone,
} from "@/lib/privacyIncidentPolicy";
import type { IncidentEvent, PrivacyIncident } from "@/lib/privacyIncidents";

export interface IncidentBadge {
  label: string;
  tone: IncidentTone;
  /** What assistive tech says instead of the compacted label. */
  spoken: string;
}

/**
 * The severity badge.
 *
 * `investigating` is the server's DEFAULT when a caller omits severity
 * (incidents.go:818) — so it means "nobody has graded this yet", which is a
 * different sentence from "low". It is deliberately toned `info` rather than
 * neutral so an ungraded breach does not read as a settled, minor one.
 */
export function incidentSeverityBadge(
  incident: PrivacyIncident,
): IncidentBadge {
  switch (incident.severity) {
    case "critical":
      return { label: "Critical", tone: "danger", spoken: "Severity critical" };
    case "high":
      return { label: "High", tone: "danger", spoken: "Severity high" };
    case "medium":
      return { label: "Medium", tone: "warning", spoken: "Severity medium" };
    case "low":
      return { label: "Low", tone: "neutral", spoken: "Severity low" };
    case "investigating":
      return {
        label: "Investigating",
        tone: "info",
        spoken: "Severity not graded yet — still investigating",
      };
    default:
      return {
        label: incident.severityRaw || EMDASH,
        tone: "neutral",
        spoken: incident.severityRaw
          ? `Severity ${incident.severityRaw}, which this app does not recognise`
          : "No severity recorded",
      };
  }
}

/** The workflow-state badge. Unknown states are shown verbatim, never blank. */
export function incidentStateBadge(incident: PrivacyIncident): IncidentBadge {
  if (!incident.status) {
    return {
      label: incident.statusRaw || EMDASH,
      tone: "neutral",
      spoken: incident.statusRaw
        ? `State ${incident.statusRaw}, which this app does not recognise`
        : "No workflow state recorded",
    };
  }
  const label = INCIDENT_STATE_LABEL[incident.status];
  const tone: IncidentTone =
    incident.status === "closed"
      ? "success"
      : incident.status === "open"
        ? "danger"
        : "warning";
  return { label, tone, spoken: `State ${label.toLowerCase()}` };
}

/**
 * The affected-subject count.
 *
 * Explicit zero is preserved. Only an omitted value means no count was
 * recorded, and that absence renders as an em-dash rather than an invented 0.
 */
export function incidentSubjectCount(incident: PrivacyIncident): IncidentBadge {
  if (incident.affectedSubjectCount === null) {
    return {
      label: EMDASH,
      tone: "neutral",
      spoken: "Affected people not recorded",
    };
  }
  const n = incident.affectedSubjectCount;
  return {
    label: num(n),
    tone: "neutral",
    spoken: `${n} ${n === 1 ? "person" : "people"} affected`,
  };
}

/**
 * The sentence for one ledger row.
 *
 * A notification row is deliberately described by AUDIENCE and TEMPLATE and
 * never by recipient: `recipient_ref` can be a regulator portal case number or
 * a person's email, and a breach ledger scrolled on a train should not put a
 * data subject's address on the glass. The detail row still carries it for the
 * reader who taps in.
 */
export function incidentEventSentence(event: IncidentEvent): string {
  if (event.kind === "transition") {
    const from = event.fromState || "created";
    const to = event.toState || EMDASH;
    const who = event.actor ? ` by ${event.actor}` : "";
    const why = event.reason ? ` — ${event.reason}` : "";
    // `transitionLabel`, not a literal arrow: the glyph is baked into a string
    // that pure code produces, so it cannot be mirrored by the layout engine
    // and an RTL reader would see the "after" value with the arrow pointing
    // away from it.
    return `${transitionLabel(from, to)}${who}${why}`;
  }
  if (event.kind === "notification") {
    const audience = event.audience || "unknown audience";
    const template = event.templateKey ? ` using ${event.templateKey}` : "";
    const who = event.actor ? ` by ${event.actor}` : "";
    return `Legacy notification assertion recorded for ${audience}${template}${who}`;
  }
  return "Ledger entry of a kind this app does not recognise";
}

/**
 * The header subtitle.
 *
 * SCOPED TO THE SAMPLE WHEN THERE IS ONE. The list is a bounded page ordered
 * `detected_at DESC`, so when the server offered more rows the total on screen
 * is a floor, not a count of the register. "3 open of 50 incidents" would be a
 * claim about a workspace that may hold four hundred; "3 open in the newest
 * 50 incidents" is the same number, told truthfully.
 */
export function incidentRegisterSubtitle(
  counts: { open: number; total: number },
  truncated: boolean,
): string {
  const total = `${num(counts.total)} ${counts.total === 1 ? "incident" : "incidents"}`;
  return truncated
    ? `${num(counts.open)} open in the newest ${total}`
    : `${num(counts.open)} open of ${total}`;
}

/** Says out loud that every count above it was computed over a sample. */
export function incidentSampleCaveat(sampled: number): string {
  return `These counts cover the ${num(sampled)} most recent ${sampled === 1 ? "incident" : "incidents"} only — older history is on the web admin.`;
}

/**
 * What this screen deliberately does NOT do, said to the operator rather than
 * left as a silent gap. Declaring a record and non-closure state moves ARE
 * available here; the notice names what remains held in every client.
 */
export const INCIDENT_DESKTOP_NOTICE =
  "Declare a preliminary record and record non-closure state changes here. Counsel sign-off, notification-evidence recording, packet generation, and incident closure are release-held in every client. This phone view shows recorded state and a legacy operational target; it does not provide legal guidance.";
