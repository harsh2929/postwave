// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LayoutTemplate, Loader2, MailPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchTextAuthed } from "@/lib/api";
import {
  type Campaign,
  campaignReportCsvPath,
  resendUnopened,
  saveCampaignAsTemplate,
} from "@/lib/campaigns-api";
import { downloadTextFile } from "@/lib/download";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  assertFreshCampaignWriteAuthority,
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Detail-header secondary actions: Save-as-template (CAMP-038), Resend to
 * non-openers (CAMP-041, sent campaigns), and Export CSV (CAMP-037, sent
 * campaigns).
 */
export function CampaignDetailActions({
  campaign,
  identity,
}: {
  campaign: Campaign;
  identity: MeResponse | null | undefined;
}) {
  const isSent = campaign.status === "sent" || campaign.status === "sending";
  const canWrite = canWriteCampaigns(identity);
  return (
    <>
      {canWrite ? (
        <SaveAsTemplateButton campaign={campaign} identity={identity} />
      ) : null}
      {isSent && canWrite ? (
        <ResendUnopenedButton campaign={campaign} identity={identity} />
      ) : null}
      {isSent ? <ExportCsvButton campaign={campaign} /> : null}
    </>
  );
}

function SaveAsTemplateButton({
  campaign,
  identity,
}: {
  campaign: Campaign;
  identity: MeResponse | null | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(campaign.name);
  const [slug, setSlug] = useState(slugify(campaign.name));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async () => {
    if (busyRef.current) return;
    if (!canWriteCampaigns(identity)) {
      toast.error(CAMPAIGN_READ_ONLY_MESSAGE);
      return;
    }
    const trimmedSlug = slug.trim() || slugify(name);
    if (!trimmedSlug) {
      const message = "A template slug is required.";
      setError(message);
      toast.error(message);
      return;
    }
    setError(null);
    const templateName = name.trim() || campaign.name;
    busyRef.current = true;
    setBusy(true);
    try {
      assertFreshCampaignWriteAuthority(identity, await whoamiFresh());
      await saveCampaignAsTemplate(campaign.id, {
        slug: trimmedSlug,
        name: templateName,
      });
      toast.success("Saved as template.");
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not save template.";
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busyRef.current) return;
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <LayoutTemplate className="h-4 w-4" />
        Save as template
      </Button>
      <DialogContent
        aria-busy={busy}
        closeDisabled={busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          window.requestAnimationFrame(() => {
            if (triggerRef.current?.isConnected && !triggerRef.current.disabled)
              triggerRef.current.focus();
          });
        }}
        onEscapeKeyDown={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>
            Reuse this campaign&apos;s subject and content as a starting point
            for future sends.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="tpl-name">Template name</Label>
            <Input
              id="tpl-name"
              disabled={busy}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(slugify(e.target.value));
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tpl-slug">Slug</Label>
            <Input
              id="tpl-slug"
              disabled={busy}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          {error ? (
            <Alert ref={errorRef} tabIndex={-1} variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResendUnopenedButton({
  campaign,
  identity,
}: {
  campaign: Campaign;
  identity: MeResponse | null | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(`Re: ${campaign.subject}`);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async () => {
    if (busyRef.current) return;
    if (!canWriteCampaigns(identity)) {
      toast.error(CAMPAIGN_READ_ONLY_MESSAGE);
      return;
    }
    const subjectSnapshot = subject.trim();
    if (!subjectSnapshot) {
      const message = "A subject is required.";
      setError(message);
      toast.error(message);
      return;
    }
    setError(null);
    busyRef.current = true;
    setBusy(true);
    try {
      assertFreshCampaignWriteAuthority(identity, await whoamiFresh());
      await resendUnopened(campaign.id, { subject: subjectSnapshot });
      toast.success("Resend to non-openers scheduled.");
      setOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not schedule resend.";
      setError(message);
      toast.error(message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busyRef.current) return;
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
      >
        <MailPlus className="h-4 w-4" />
        Resend to non-openers
      </Button>
      <DialogContent
        aria-busy={busy}
        closeDisabled={busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          window.requestAnimationFrame(() => {
            if (triggerRef.current?.isConnected && !triggerRef.current.disabled)
              triggerRef.current.focus();
          });
        }}
        onEscapeKeyDown={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busyRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Resend to non-openers</DialogTitle>
          <DialogDescription>
            Send this campaign again — with a fresh subject — only to recipients
            who didn&apos;t open the first send.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="resend-subject">New subject</Label>
          <Input
            id="resend-subject"
            disabled={busy}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
          {error ? (
            <Alert ref={errorRef} tabIndex={-1} variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Schedule resend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExportCsvButton({ campaign }: { campaign: Campaign }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const csv = await fetchTextAuthed(campaignReportCsvPath(campaign.id));
      downloadTextFile(
        `campaign-${campaign.id}-report.csv`,
        csv,
        "text/csv;charset=utf-8",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void run()}
      disabled={busy}
      aria-busy={busy}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      Export CSV
    </Button>
  );
}
