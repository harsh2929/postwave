// SPDX-License-Identifier: AGPL-3.0-only
//
// Reusable "send a test to my inbox" dialog for content that has no campaign
// id — templates (TMPL-022), sequence emails (SEQ-045), and A/B variants
// (CAMP-046). All three post to the same id-less transactional test-send
// endpoint via sendContentTest. Framed as an inbox render-check, never a live
// send, so it composes with surfaces whose activation is otherwise gated.
"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { sendContentTest } from "@/lib/campaigns-api";
import { whoami } from "@/lib/auth-api";

interface TestContent {
  subject: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
}

export function ContentTestSendDialog({
  content,
  trigger,
}: {
  /**
   * Content to send. A static object for server-rendered callers (templates),
   * or a getter read at send time for editors whose content is still mutating
   * (sequences, A/B variants). Functions can't cross the RSC boundary, so
   * server components must pass the object form.
   */
  content: TestContent | (() => TestContent);
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  // Prefill the signed-in user's email the first time the dialog opens.
  // A direct whoami() (not useQuery) keeps this component usable in trees
  // without a QueryClientProvider, and only fetches on demand. The
  // functional setter never clobbers an in-progress edit.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    whoami()
      .then((me) => {
        if (!cancelled && me?.email) setEmail((cur) => cur || me.email);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  const send = async () => {
    const to = email.trim();
    if (!to || !to.includes("@")) {
      toast.error("Enter a valid email address.");
      return;
    }
    const resolved = typeof content === "function" ? content() : content;
    if (!resolved.subject.trim()) {
      toast.error("This content has no subject to send.");
      return;
    }
    setBusy(true);
    try {
      await sendContentTest({ to_email: to, ...resolved });
      toast.success(`Test sent to ${to}.`);
      setOpen(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not send the test.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test to your inbox</DialogTitle>
          <DialogDescription>
            Renders and sends a single message to the address below — an inbox
            render check, not a live send.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="content-test-email">Test recipient</Label>
          <Input
            id="content-test-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void send()} disabled={busy}>
            <Send className="h-4 w-4" />
            {busy ? "Sending…" : "Send test"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
