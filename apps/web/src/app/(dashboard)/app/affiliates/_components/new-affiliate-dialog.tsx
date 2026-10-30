// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createAffiliate } from "@/lib/affiliates-api";

/**
 * Retained source prototype only. Active affiliate routes deliberately do not
 * import this control while the complete program is release-held, and its API
 * wrapper fails before transport if an older caller renders it accidentally.
 */
export function NewAffiliateButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        New affiliate
      </Button>
      {open ? <NewAffiliateDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NewAffiliateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [website, setWebsite] = useState("");
  const [audienceSize, setAudienceSize] = useState("");
  const [audienceDesc, setAudienceDesc] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = email.trim() !== "" && name.trim() !== "" && !busy;

  async function submit() {
    setBusy(true);
    try {
      const size = Number.parseInt(audienceSize, 10);
      await createAffiliate({
        email: email.trim(),
        name: name.trim(),
        country: country.trim() || undefined,
        website: website.trim() || undefined,
        audienceSize: Number.isFinite(size) && size > 0 ? size : undefined,
        audienceDesc: audienceDesc.trim() || undefined,
      });
      toast.success("Affiliate created.");
      onClose();
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create affiliate.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New affiliate</DialogTitle>
          <DialogDescription>
            Operator-created affiliates are approved immediately. They can be
            suspended later from the affiliate&apos;s Settings tab.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="a-name">Name</Label>
              <Input
                id="a-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-email">Email</Label>
              <Input
                id="a-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="a-country">Country (ISO-2, optional)</Label>
              <Input
                id="a-country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="US"
                maxLength={6}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="a-size">Audience size (optional)</Label>
              <Input
                id="a-size"
                type="number"
                min={0}
                value={audienceSize}
                onChange={(e) => setAudienceSize(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-website">Website (optional)</Label>
            <Input
              id="a-website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a-desc">Audience description (optional)</Label>
            <Textarea
              id="a-desc"
              rows={3}
              value={audienceDesc}
              onChange={(e) => setAudienceDesc(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {busy ? "Creating…" : "Create affiliate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
