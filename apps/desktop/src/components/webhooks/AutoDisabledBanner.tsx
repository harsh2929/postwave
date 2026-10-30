/**
 * AutoDisabledBanner — visible above an outbound webhook when the
 * worker has auto-disabled it (consecutive_failures >= threshold).
 * Single "Re-enable" button calls the new endpoint and triggers a
 * cache refresh on the parent's health card. PR 1.
 */

import { type ReactElement, useState } from "react";

import { api } from "../../lib/api-client";
import { Banner } from "../Banner";
import { toast } from "../Toast";

export interface AutoDisabledBannerProps {
  webhookId: string;
  onReEnabled: () => void;
}

export function AutoDisabledBanner({
  webhookId,
  onReEnabled,
}: AutoDisabledBannerProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const click = async (): Promise<void> => {
    setBusy(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (api as any).reEnableWebhook(webhookId);
    setBusy(false);
    if (res.error) {
      toast.error(`Re-enable failed: ${res.error.message}`);
      return;
    }
    toast.success("Re-enabled — new deliveries will start flowing.");
    onReEnabled();
  };
  return (
    <Banner
      tone="danger"
      title="Auto-disabled"
      style={{ margin: "8px 0" }}
      action={
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void click()}
          disabled={busy}
        >
          {busy ? "Re-enabling…" : "Re-enable"}
        </button>
      }
    >
      This webhook hit the consecutive-failure
        limit and the worker stopped sending. Re-enabling resets the failure
        counter — fix the receiver first, otherwise it will disable again.
    </Banner>
  );
}
