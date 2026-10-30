import { SOURCE_LABELS, type SourcePlatform } from "./types";

export type SourceSessionStatusKind = "ok" | "near" | "expired" | "missing";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_BRIDGE_CUTOVER_WINDOW_MS = 14 * ONE_DAY_MS;

export interface SourceSessionStatus {
  kind: SourceSessionStatusKind;
  message: string;
  /** Near-expiry bridge sessions are rejected by the migration service. */
  blocksAction?: boolean;
}

export function sourceSessionBlocksAction(
  status: SourceSessionStatus,
): boolean {
  return (
    status.blocksAction === true ||
    status.kind === "expired" ||
    status.kind === "missing"
  );
}

export function sourceSessionStatus(
  source: SourcePlatform,
  expiresAt: string | null | undefined,
  actionLabel: string,
): SourceSessionStatus {
  if (!expiresAt) {
    return {
      kind: "missing",
      message: `The saved ${SOURCE_LABELS[source]} session is no longer available. Reconnect before starting ${actionLabel}.`,
    };
  }
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires))
    return {
      kind: "missing",
      message: `The saved ${SOURCE_LABELS[source]} session has no valid expiry. Reconnect before starting ${actionLabel}.`,
      blocksAction: true,
    };
  const remaining = expires - Date.now();
  if (remaining <= 0) {
    return {
      kind: "expired",
      message: `The source session has expired. Reconnect before starting ${actionLabel}.`,
    };
  }
  if (remaining <= nearExpiryWindowMs(source)) {
    if (isSourceBridge(source)) {
      return {
        kind: "near",
        message: `Moosewave's saved ${SOURCE_LABELS[source]} source-session retention ends ${new Date(expiresAt).toLocaleString()}. Reconnect before starting ${actionLabel} so the saved session cannot expire mid-run.`,
        blocksAction: true,
      };
    }
    return {
      kind: "near",
      message: `Moosewave's saved ${SOURCE_LABELS[source]} source-session retention ends ${new Date(expiresAt).toLocaleString()}. You can continue ${actionLabel}, but start soon and reconnect if the job runs past this saved-session retention.`,
    };
  }
  return { kind: "ok", message: "" };
}

function nearExpiryWindowMs(source: SourcePlatform): number {
  if (isSourceBridge(source)) {
    return SOURCE_BRIDGE_CUTOVER_WINDOW_MS;
  }
  return ONE_DAY_MS;
}

function isSourceBridge(source: SourcePlatform): boolean {
  return (
    source === "activecampaign" ||
    source === "hubspot" ||
    source === "beehiiv" ||
    source === "klaviyo" ||
    source === "customerio"
  );
}
