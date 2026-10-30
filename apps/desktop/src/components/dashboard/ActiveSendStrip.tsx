/**
 * ActiveSendStrip — StatusBar inline strip shown only when a campaign
 * is currently sending. Pulled from the shared store; the dashboard's
 * campaigns list populates this when it sees a row with status='sending'.
 *
 * Renders nothing when no campaign is sending — gives StatusBar back
 * to its normal layout.
 */

import { type ReactElement } from "react";

import { navigateDesktopSectionResource } from "../../lib/desktop-router";
import { setSection, useActiveSend } from "../../lib/store";

function fmtPct(p: number | null | undefined): string {
  if (typeof p !== "number" || !Number.isFinite(p)) return "—";
  const v = p > 1 ? p : p * 100;
  return `${v.toFixed(1)}%`;
}

export function ActiveSendStrip(): ReactElement | null {
  const activeSend = useActiveSend();
  if (!activeSend) return null;
  return (
    <button
      type="button"
      className="statusbar-send-strip"
      onClick={() => {
        if (activeSend.campaignId) {
          navigateDesktopSectionResource("campaigns", activeSend.campaignId);
          return;
        }
        setSection("campaigns");
      }}
      aria-label={`Open ${activeSend.name}; campaign is currently sending`}
    >
      <span className="statusbar-send-dot" aria-hidden />
      <span>Sending</span>
      <strong className="statusbar-send-name">{activeSend.name}</strong>
      <span className="statusbar-sep" />
      <span className="tabular">{fmtPct(activeSend.openRate)} open</span>
      <span className="muted tabular statusbar-send-click-rate">
        {fmtPct(activeSend.clickRate)} click
      </span>
    </button>
  );
}
