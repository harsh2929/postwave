import {
  capabilityForSection,
  type DesktopCapabilityReadiness,
  type DesktopNavDomain,
} from "./desktop-capabilities";
import { routeMetaForSection } from "./desktop-routes";
import type { ConnectivityReason } from "./online-manager";
import type { Section } from "./store";

export type ContextualHelpTask =
  | "general"
  | "setup"
  | "navigate"
  | "create"
  | "edit"
  | "send"
  | "import"
  | "export"
  | "sync"
  | "billing"
  | "recovery";

export interface ContextualHelpRequest {
  task?: ContextualHelpTask;
  /** Structural code only; raw messages never enter help state. */
  errorCode?: string;
  /** Generated Moosewave incident identifier only. */
  incidentId?: string;
}

export interface ContextualHelpSnapshot {
  destination: Section;
  destinationTitle: string;
  capabilityId: string;
  domain: DesktopNavDomain;
  readiness: DesktopCapabilityReadiness;
  limitation: string | null;
  recoverySection: Section | null;
  connectivity: ConnectivityReason;
  task: ContextualHelpTask;
  errorCode: string | null;
  incidentId: string | null;
}

export interface ContextualHelpGuide {
  id: DesktopNavDomain;
  title: string;
  summary: string;
  steps: readonly string[];
}

export interface ContextualSelfServiceItem {
  id: "guide" | "connectivity" | "availability";
  title: string;
  description: string;
}

const HELP_TASKS = new Set<ContextualHelpTask>([
  "general",
  "setup",
  "navigate",
  "create",
  "edit",
  "send",
  "import",
  "export",
  "sync",
  "billing",
  "recovery",
]);
const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_-]{0,31}$/u;
const INCIDENT_ID_RE = /^PW-[A-Z0-9-]{8,32}$/u;
const SENSITIVE_CODE_RE =
  /(?:API[_-]?KEY|AUTH|BEARER|COOKIE|OAUTH|PASSWORD|SECRET|SESSION|TOKEN)/u;

const DOMAIN_GUIDES: Readonly<Record<DesktopNavDomain, ContextualHelpGuide>> = {
  home: {
    id: "home",
    title: "Orient your workspace",
    summary: "Use the Dashboard to resume work and inspect account health.",
    steps: [
      "Review alerts and work that needs attention before starting a new task.",
      "Reorder dashboard cards with the visible move controls.",
      "Use Search to open a destination or record without scanning the sidebar.",
    ],
  },
  audience: {
    id: "audience",
    title: "Find and organize people",
    summary:
      "Start with Subscribers, then narrow with lists, tags, or segments.",
    steps: [
      "Search for a subscriber before creating a duplicate record.",
      "Use lists for membership, tags for labels, and segments for live rules.",
      "Review consent and suppression state before changing channel eligibility.",
    ],
  },
  messaging: {
    id: "messaging",
    title: "Create and review a message",
    summary: "Move from a saved draft through checks, approval, and delivery.",
    steps: [
      "Keep the audience, sender, and content draft explicit before previewing.",
      "Run pre-send checks and resolve blockers before approval or scheduling.",
      "Use test delivery and review the final audience before sending.",
    ],
  },
  growth: {
    id: "growth",
    title: "Operate publishing and growth",
    summary: "Confirm provider readiness before changing a growth program.",
    steps: [
      "Check whether this capability is operational, read-only, or provider-dependent.",
      "Review the active program or integration before creating another one.",
      "Confirm attribution and eligibility rules before publishing changes.",
    ],
  },
  connections: {
    id: "connections",
    title: "Connect and diagnose data",
    summary:
      "Verify environment, credentials, scopes, and recent delivery evidence.",
    steps: [
      "Confirm the target workspace and environment before entering credentials.",
      "Use Test or Diagnostics before enabling a connection.",
      "Review recent runs, retries, and cleanup requirements after changes.",
    ],
  },
  insights: {
    id: "insights",
    title: "Interpret delivery and analytics",
    summary: "Check scope and freshness before acting on a metric.",
    steps: [
      "Confirm the date range, audience, provider, and data freshness.",
      "Use the exact data table when a chart trend needs verification.",
      "Separate delivery health, engagement, and attribution before remediation.",
    ],
  },
  ai: {
    id: "ai",
    title: "Use AI with review controls",
    summary:
      "Treat generated output as a draft and inspect its source context.",
    steps: [
      "Choose the task and source material before generating.",
      "Review claims, audience fit, and brand voice before accepting output.",
      "Save or discard the draft explicitly; generation never sends by itself.",
    ],
  },
  governance: {
    id: "governance",
    title: "Review and govern safely",
    summary:
      "Use exact scope, evidence, and reason fields for consequential work.",
    steps: [
      "Confirm the workspace, resource, actor, and permission boundary.",
      "Record a specific reason before approving, rejecting, exporting, or deleting.",
      "Keep the resulting audit or recovery evidence for handoff.",
    ],
  },
  settings: {
    id: "settings",
    title: "Change workspace settings",
    summary:
      "Check scope and consequences before saving an account-wide change.",
    steps: [
      "Use Settings search or a direct Settings anchor to find the exact control.",
      "Review role, plan, and provider requirements before editing.",
      "Save one coherent change and verify its acknowledged state.",
    ],
  },
};

export function sanitizeContextualHelpRequest(
  value: unknown,
): ContextualHelpRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const task =
    typeof record.task === "string" &&
    HELP_TASKS.has(record.task as ContextualHelpTask)
      ? (record.task as ContextualHelpTask)
      : undefined;
  const errorCode = safeErrorCode(record.errorCode);
  const incidentId = safeIncidentId(record.incidentId);
  return {
    ...(task ? { task } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(incidentId ? { incidentId } : {}),
  };
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" &&
    SAFE_ERROR_CODE_RE.test(value) &&
    !SENSITIVE_CODE_RE.test(value)
    ? value
    : undefined;
}

function safeIncidentId(value: unknown): string | undefined {
  return typeof value === "string" && INCIDENT_ID_RE.test(value)
    ? value
    : undefined;
}

export function buildContextualHelpSnapshot(input: {
  section: Section;
  connectivity: ConnectivityReason;
  request?: ContextualHelpRequest;
}): ContextualHelpSnapshot {
  const request = sanitizeContextualHelpRequest(input.request);
  const capability = capabilityForSection(input.section);
  return {
    destination: input.section,
    destinationTitle: routeMetaForSection(input.section).title,
    capabilityId: capability.id,
    domain: capability.domain,
    readiness: capability.readiness,
    limitation: capability.limitation ?? null,
    recoverySection: capability.recoverySection ?? null,
    connectivity: input.connectivity,
    task: request.task ?? "general",
    errorCode: request.errorCode ?? null,
    incidentId: request.incidentId ?? null,
  };
}

export function contextualHelpGuide(
  snapshot: ContextualHelpSnapshot,
): ContextualHelpGuide {
  return DOMAIN_GUIDES[snapshot.domain];
}

export function contextualSelfServiceItems(
  snapshot: ContextualHelpSnapshot,
): ContextualSelfServiceItem[] {
  const guide = contextualHelpGuide(snapshot);
  const items: ContextualSelfServiceItem[] = [
    { id: "guide", title: guide.title, description: guide.summary },
  ];
  if (snapshot.connectivity !== "online") {
    items.push({
      id: "connectivity",
      title: "Restore the connection",
      description: connectivityHelp(snapshot.connectivity),
    });
  }
  if (snapshot.limitation) {
    items.push({
      id: "availability",
      title: "Check availability",
      description: snapshot.limitation,
    });
  }
  return items;
}

export function connectivitySupportErrorCode(
  reason: ConnectivityReason,
): string | null {
  switch (reason) {
    case "no-interface":
      return "NO_INTERFACE";
    case "internet-unavailable":
      return "INTERNET_UNAVAILABLE";
    case "api-unavailable":
      return "API_UNAVAILABLE";
    case "maintenance":
      return "MAINTENANCE";
    case "authentication":
      return "ACCESS_REQUIRED";
    case "captive-portal":
      return "CAPTIVE_PORTAL";
    case "proxy-tls":
      return "PROXY_TLS";
    case "connecting":
      return "CONNECTING";
    case "online":
    default:
      return null;
  }
}

function connectivityHelp(reason: ConnectivityReason): string {
  switch (reason) {
    case "no-interface":
      return "Reconnect this device to a network, then retry the task.";
    case "internet-unavailable":
      return "Confirm that another secure site opens, then retry.";
    case "api-unavailable":
    case "maintenance":
      return "Keep the draft open and retry after the Moosewave API recovers.";
    case "authentication":
      return "Re-authenticate before retrying; do not paste credentials into support context.";
    case "captive-portal":
      return "Complete the network sign-in page, then retry the connection check.";
    case "proxy-tls":
      return "Ask the network administrator to allow Moosewave TLS traffic, then retry.";
    case "connecting":
      return "Wait for the connection check to finish before retrying.";
    case "online":
    default:
      return "The connection currently reports online.";
  }
}

export function buildContextualSupportText(
  snapshot: ContextualHelpSnapshot,
): string {
  return [
    "Moosewave Desktop support context (structural; no identity, resource ID, content, or credentials)",
    `Destination: ${snapshot.destinationTitle} (${snapshot.destination})`,
    `Capability: ${snapshot.capabilityId}`,
    `Domain: ${snapshot.domain}`,
    `Readiness: ${snapshot.readiness}`,
    `Connection: ${snapshot.connectivity}`,
    `Task: ${snapshot.task}`,
    `Error code: ${snapshot.errorCode ?? "not available"}`,
    `Incident: ${snapshot.incidentId ?? "not available"}`,
  ].join("\n");
}

export function buildContextualSupportUrl(
  baseUrl: string,
  snapshot: ContextualHelpSnapshot,
): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  url.hash = "";
  url.searchParams.set("source", "desktop");
  url.searchParams.set("destination", snapshot.destination);
  url.searchParams.set("domain", snapshot.domain);
  url.searchParams.set("readiness", snapshot.readiness);
  url.searchParams.set("connection", snapshot.connectivity);
  url.searchParams.set("task", snapshot.task);
  if (snapshot.errorCode)
    url.searchParams.set("error_code", snapshot.errorCode);
  if (snapshot.incidentId)
    url.searchParams.set("incident_id", snapshot.incidentId);
  return url.toString();
}
