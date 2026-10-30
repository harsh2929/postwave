// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CampaignTestSendSection({
  busy = false,
  onChangeEmail,
  onSend,
  testEmail,
}: {
  /**
   * The editor's operation-in-flight flag (`saving` from
   * useCampaignSaveWorkflow). A test send is a save-then-send — validate links,
   * PATCH the campaign, re-check authority, POST the test — which runs for
   * seconds, and the workflow's latch swallows every click made meanwhile. Pass
   * it so the button shows the work instead of reading as broken. It covers any
   * operation, not just this one, hence the neutral "Working…".
   */
  busy?: boolean;
  onChangeEmail: (value: string) => void;
  onSend: () => void;
  testEmail: string;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="grid flex-1 gap-2">
          <Label htmlFor="test-email">Test recipient</Label>
          <Input
            id="test-email"
            type="email"
            value={testEmail}
            onChange={(event) => onChangeEmail(event.target.value)}
          />
        </div>
        <Button
          type="button"
          onClick={onSend}
          loading={busy}
          title={
            busy ? "Waiting for the campaign operation in flight" : undefined
          }
        >
          {busy ? null : <Send className="h-4 w-4" />}
          {busy ? "Working…" : "Send test"}
        </Button>
      </div>
    </section>
  );
}
