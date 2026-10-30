// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Edit a subscriber's name / status / tags / custom fields from the web
// profile (SUB-012). PATCH /subscribers/{id} with optimistic concurrency —
// a 412/409 is surfaced so the operator can reload rather than clobber.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { Select } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { isApiError } from "@/lib/api";
import {
  isExactSubscriberVersion,
  updateSubscriber,
  type Subscriber,
  type SubscriberStatus,
} from "@/lib/subscribers-api";
import {
  reauthorizeSubscriberMutation,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import {
  canReviewEnable,
  EnableWithEvidenceDialog,
} from "@/components/subscribers/EnableWithEvidenceDialog";
import {
  mergeCustomFieldEdits,
  CustomFieldsEditor,
  CustomFieldsEditorSkeleton,
  useCustomFields,
} from "@/app/(dashboard)/app/subscribers/subscribers-custom-fields";

export function EditSubscriberDialog({
  open,
  onOpenChange,
  subscriber,
  authority,
  onSaved,
  onReload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscriber: Subscriber;
  authority: SubscriberAuthority;
  onSaved: (updated: Subscriber) => void;
  onReload?: () => void | Promise<void>;
}) {
  const customFields = useCustomFields();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [locale, setLocale] = useState("");
  const [language, setLanguage] = useState("");
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");
  const [emailRotationReviewed, setEmailRotationReviewed] = useState(false);
  const [status, setStatus] = useState<SubscriberStatus>("enabled");
  const [tags, setTags] = useState("");
  const [cfValues, setCfValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const savingRef = useRef(false);
  const reloadingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  // Hydrate the form whenever the dialog opens on a (possibly refreshed) record.
  useEffect(() => {
    if (!open) return;
    setFirstName(subscriber.first_name ?? "");
    setLastName(subscriber.last_name ?? "");
    setEmail(subscriber.email);
    setFullName(subscriber.full_name ?? "");
    setDisplayName(subscriber.display_name ?? "");
    setLocale(subscriber.locale ?? "");
    setLanguage(subscriber.language ?? "");
    setCountry(subscriber.country ?? "");
    setRegion(subscriber.region ?? "");
    setEmailRotationReviewed(false);
    setStatus(subscriber.status);
    setTags(subscriber.tags.join(", "));
    setError(null);
    setConflicted(false);
    const initial: Record<string, string> = {};
    for (const [key, value] of Object.entries(subscriber.custom_fields ?? {})) {
      if (value === null || value === undefined) continue;
      initial[key] = String(value);
    }
    setCfValues(initial);
  }, [open, subscriber]);

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    savingRef.current = false;
    setSaving(false);
  }, [subscriber.id, authority.tenantId, authority.userId, authority.role]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (savingRef.current || reloadingRef.current) return;
    setError(null);
    setConflicted(false);
    savingRef.current = true;
    setSaving(true);
    const generation = ++generationRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    let updated: Subscriber | null = null;
    try {
      if (
        !subscriber.id ||
        !isExactSubscriberVersion(subscriber.version, subscriber.id)
      ) {
        throw new Error("Reload the exact subscriber revision before saving.");
      }
      await reauthorizeSubscriberMutation(authority);
      const emailChanged =
        email.trim().toLowerCase() !== subscriber.email.toLowerCase();
      updated = await updateSubscriber(
        subscriber.id,
        {
          ...(emailChanged ? { email: email.trim().toLowerCase() } : {}),
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          full_name: fullName.trim(),
          display_name: displayName.trim(),
          locale: locale.trim(),
          language: language.trim().toLowerCase(),
          country: country.trim().toUpperCase(),
          region: region.trim(),
          ...(status !== subscriber.status ? { status } : {}),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          // The backend treats a non-nil custom_fields as a FULL REPLACE (see the
          // documented subscribers PATCH-replace semantics), so this has to send
          // the whole intended map: ad-hoc keys the editor never renders (the
          // list's display `name`, anything an import created) must survive, and
          // a defs query that hasn't loaded must not wipe everything.
          //
          // It previously spread buildCustomFields over the existing map, which
          // got both of those right and clearing wrong: buildCustomFields drops
          // empty values, so an emptied box was absent from the spread and the
          // old value survived underneath it. mergeCustomFieldEdits keeps the
          // untouched keys and treats "" as a removal.
          custom_fields: mergeCustomFieldEdits(
            subscriber.custom_fields ?? {},
            customFields.data ?? [],
            cfValues,
          ),
        },
        {
          expectedVersion: subscriber.version,
          idempotencyKey: `subscriber-edit:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
          signal: controller.signal,
        },
      );
      await reauthorizeSubscriberMutation(authority);
      if (generation !== generationRef.current) return;
      toast.success("Subscriber updated.");
      onSaved(updated);
      onOpenChange(false);
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (updated) {
        onSaved(updated);
        toast.info(
          "The subscriber saved, but workspace access changed afterward. The profile was reloaded.",
        );
        onOpenChange(false);
        return;
      }
      if (isApiError(err) && (err.status === 412 || err.status === 409)) {
        const message =
          "This contact changed since you opened it. Reload the latest contact before saving again.";
        setError(message);
        setConflicted(true);
        toast.error(message);
      } else {
        const message =
          err instanceof DOMException && err.name === "AbortError"
            ? "The save was cancelled because the subscriber context changed."
            : isApiError(err) && (err.status === 400 || err.status === 422)
              ? "Review the profile fields and try again. No change was confirmed."
              : "Could not confirm the profile change. Reload before trying again.";
        setError(message);
        toast.error(message);
      }
    } finally {
      savingRef.current = false;
      abortRef.current = null;
      setSaving(false);
    }
  };

  const nextTags = tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const nextCustomFields = mergeCustomFieldEdits(
    subscriber.custom_fields ?? {},
    customFields.data ?? [],
    cfValues,
  );
  const unchanged =
    email.trim().toLowerCase() === subscriber.email.toLowerCase() &&
    firstName.trim() === (subscriber.first_name ?? "") &&
    lastName.trim() === (subscriber.last_name ?? "") &&
    fullName.trim() === (subscriber.full_name ?? "") &&
    displayName.trim() === (subscriber.display_name ?? "") &&
    locale.trim() === (subscriber.locale ?? "") &&
    language.trim().toLowerCase() === (subscriber.language ?? "") &&
    country.trim().toUpperCase() === (subscriber.country ?? "") &&
    region.trim() === (subscriber.region ?? "") &&
    status === subscriber.status &&
    JSON.stringify(nextTags) === JSON.stringify(subscriber.tags) &&
    JSON.stringify(nextCustomFields) ===
      JSON.stringify(subscriber.custom_fields ?? {});
  const mutationPending = saving || reloading;
  const emailChanged =
    email.trim().toLowerCase() !== subscriber.email.toLowerCase();
  const availableStatuses: SubscriberStatus[] =
    subscriber.status === "enabled"
      ? ["enabled", "unconfirmed", "disabled"]
      : subscriber.status === "blocklisted"
        ? ["blocklisted"]
        : ["unconfirmed", "disabled"];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (savingRef.current || reloadingRef.current)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        aria-busy={mutationPending}
        onEscapeKeyDown={(event) => {
          if (savingRef.current || reloadingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (savingRef.current || reloadingRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit subscriber</DialogTitle>
          <DialogDescription>
            Update profile fields, delivery status, tags, and custom fields.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4 py-2" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="edit-email">Canonical email</Label>
              <Input
                id="edit-email"
                type="email"
                maxLength={320}
                disabled={mutationPending}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailRotationReviewed(false);
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-first">First name</Label>
              <Input
                id="edit-first"
                disabled={mutationPending}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-last">Last name</Label>
              <Input
                id="edit-last"
                disabled={mutationPending}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-full">Full name</Label>
              <Input
                id="edit-full"
                disabled={mutationPending}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-display">Display name</Label>
              <Input
                id="edit-display"
                disabled={mutationPending}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-locale">Locale</Label>
              <Input
                id="edit-locale"
                disabled={mutationPending}
                value={locale}
                placeholder="en-IN"
                onChange={(e) => setLocale(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-language">Language</Label>
              <Input
                id="edit-language"
                disabled={mutationPending}
                maxLength={2}
                value={language}
                placeholder="en"
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-country">Country</Label>
              <Input
                id="edit-country"
                disabled={mutationPending}
                maxLength={2}
                value={country}
                placeholder="IN"
                onChange={(e) => setCountry(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-region">Region</Label>
              <Input
                id="edit-region"
                disabled={mutationPending}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
          </div>
          {emailChanged ? (
            <label className="flex min-h-11 items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-primary"
                checked={emailRotationReviewed}
                disabled={mutationPending}
                onChange={(event) =>
                  setEmailRotationReviewed(event.target.checked)
                }
              />
              <span>
                I reviewed this identity rotation. A genuinely new address
                starts without marketing consent; existing address evidence is
                never copied from the old email.
              </span>
            </label>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor="edit-status">Status</Label>
            <Select
              id="edit-status"
              disabled={mutationPending}
              value={status}
              onChange={(e) => setStatus(e.target.value as SubscriberStatus)}
            >
              {availableStatuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              Subscribed is never a plain status change: it is recorded with
              reviewed opt-in evidence. Use Suppress for a canonical blocklist
              change.
            </p>
            {canReviewEnable(subscriber) ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={mutationPending || !unchanged}
                  title={
                    unchanged
                      ? undefined
                      : "Save or discard the other edits first — enabling saves the profile on its own."
                  }
                  onClick={() => setReviewOpen(true)}
                >
                  {subscriber.status === "unconfirmed"
                    ? "Review consent & confirm"
                    : "Review consent & enable"}
                </Button>
                {!unchanged ? (
                  <span className="text-xs text-muted-foreground">
                    Save or discard the other edits first.
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-tags">Tags (comma-separated)</Label>
            <Input
              id="edit-tags"
              disabled={mutationPending}
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          {customFields.isLoading ? (
            <CustomFieldsEditorSkeleton />
          ) : (
            <CustomFieldsEditor
              fields={Array.isArray(customFields.data) ? customFields.data : []}
              values={cfValues}
              idPrefix="edit-cf"
              disabled={mutationPending}
              onChange={(key, value) =>
                setCfValues((prev) => ({ ...prev, [key]: value }))
              }
            />
          )}
          {error ? (
            <Alert ref={errorRef} tabIndex={-1} variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={mutationPending}>
                Cancel
              </Button>
            </DialogClose>
            {conflicted && onReload ? (
              <Button
                type="button"
                variant="outline"
                disabled={mutationPending}
                onClick={async () => {
                  if (savingRef.current || reloadingRef.current) return;
                  reloadingRef.current = true;
                  setReloading(true);
                  try {
                    await onReload();
                    setError(null);
                    setConflicted(false);
                  } catch {
                    setError("Could not reload the latest contact.");
                  } finally {
                    reloadingRef.current = false;
                    setReloading(false);
                  }
                }}
              >
                {reloading ? "Reloading…" : "Reload latest"}
              </Button>
            ) : null}
            <Button
              type="submit"
              disabled={
                mutationPending ||
                customFields.isLoading ||
                unchanged ||
                (emailChanged && !emailRotationReviewed)
              }
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
      <EnableWithEvidenceDialog
        subscriber={subscriber}
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        authority={authority}
        onEnabled={(updated) => {
          onSaved(updated);
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
