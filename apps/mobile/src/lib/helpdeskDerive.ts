/**
 * What the Helpdesk UI derives from a parsed row: its sort key, the words it
 * shows, the claim action a viewer may take, and the standing disclosures.
 *
 * The copy constants live with the logic they qualify. Each one states a
 * release fact — outbound delivery is absent, note editing is held, the queue
 * can reorder — and a surface that shows Helpdesk data without them is
 * claiming more than the server can prove.
 */
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import type { HelpdeskConversation } from "@/lib/helpdeskTypes";

export function conversationSortKey(row: HelpdeskConversation): string {
  return row.lastMessageAt ?? row.updatedAt;
}

export function conversationTitle(row: HelpdeskConversation): string {
  return (
    row.requesterName ??
    row.requesterEmail ??
    row.requesterPhone ??
    "Unidentified sender"
  );
}

export function conversationSubtitle(row: HelpdeskConversation): string | null {
  if (row.subject) return row.subject;
  if (row.channelType) return humanizeToken(row.channelType) + " conversation";
  return null;
}

export function humanizeToken(value: string): string {
  const spaced = value.replaceAll("_", " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}

export type HelpdeskStatusTone = "success" | "warning" | "danger" | "neutral";

export function statusTone(status: string): HelpdeskStatusTone {
  if (status === "open" || status === "pending" || status === "waiting")
    return "warning";
  if (status === "resolved" || status === "closed") return "success";
  if (status === "spam") return "danger";
  return "neutral";
}

const ACTIVE = new Set(["open", "pending", "waiting"]);

export function activeConversationCount(
  rows: readonly HelpdeskConversation[],
): number {
  return rows.filter((row) => ACTIVE.has(row.status)).length;
}

export interface HelpdeskAdminAccess {
  allowed: boolean;
  notice: string | null;
}

export function helpdeskAdminAccess(input: {
  role: string | null | undefined;
  mode: "session" | "api_key" | null | undefined;
  online: boolean;
}): HelpdeskAdminAccess {
  if (!canAccessMinimumRole("admin", input.role, input.mode)) {
    return {
      allowed: false,
      notice:
        input.mode === "api_key"
          ? "Helpdesk requires an owner or admin workspace session; this app cannot verify API-key scopes."
          : "Helpdesk records are restricted to workspace owners and admins.",
    };
  }
  if (!input.online) {
    return {
      allowed: false,
      notice:
        "You are offline. Helpdesk data is not stored on this device and internal notes are never queued.",
    };
  }
  return { allowed: true, notice: null };
}

export const HELPDESK_SCOPE_NOTE =
  "Only bounded rows recorded in this workspace appear here, and the queue can reorder as records change. SMS, email, and provider ingestion are release-held; an empty queue is not proof that no customer contacted you.";

export const HELPDESK_INTERNAL_NOTE_LIFECYCLE_NOTE =
  "Stored internal notes cannot currently be edited or deleted through Helpdesk, and their privacy lifecycle is release-held.";

export const HELPDESK_DELIVERY_NOTE = `Outbound replies are unavailable in this release. Internal notes stay in this workspace and are never delivered to the customer. ${HELPDESK_INTERNAL_NOTE_LIFECYCLE_NOTE} This bounded history can reorder as records change.`;

export type HelpdeskClaimAction = "claim" | "takeover" | "unassign" | "none";

export function helpdeskClaimAction(
  conversation: {
    assignmentState: HelpdeskConversation["assignmentState"];
    assignedToUserId: string | null;
  },
  viewerUserId: string | null | undefined,
): HelpdeskClaimAction {
  const me = (viewerUserId ?? "").trim().toLowerCase();
  if (!me) return "none";
  if (conversation.assignmentState === "legacy_unverified") return "takeover";
  if (conversation.assignmentState === "unassigned") return "claim";
  const owner = (conversation.assignedToUserId ?? "").trim().toLowerCase();
  if (!owner) return "none";
  return owner === me ? "unassign" : "takeover";
}

export function helpdeskClaimLabel(action: HelpdeskClaimAction): string | null {
  if (action === "claim") return "Assign to me";
  if (action === "takeover") return "Take over";
  if (action === "unassign") return "Unassign";
  return null;
}
