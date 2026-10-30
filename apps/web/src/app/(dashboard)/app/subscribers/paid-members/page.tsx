// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, Search, X } from "lucide-react";
import { toast } from "sonner";

import { createLatestRequestGate } from "@/lib/latest-request";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/dashboard/page-shell";
import { formatListDate } from "@/app/(dashboard)/app/subscribers/subscribers-list-helpers";
import {
  grantPaidMember,
  listPaidMembers,
  revokePaidMember,
  type PaidMember,
} from "@/lib/paywall-api";

const STATUSES = ["", "active", "past_due", "canceled", "paused"] as const;
const EDITABLE_STATUSES = ["active", "past_due", "paused", "canceled"] as const;

// Same regex the subscribers list uses, so grant-access validation is consistent.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function PaidMembersPage() {
  const [filter, setFilter] = useState("");
  const [emailQuery, setEmailQuery] = useState("");
  const [members, setMembers] = useState<PaidMember[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [grantEmail, setGrantEmail] = useState("");
  const [grantTier, setGrantTier] = useState("");
  const [granting, setGranting] = useState(false);
  const grantingRef = useRef(false);
  const grantSurfaceRef = useRef<HTMLDivElement>(null);
  // Inline validation error for the grant-email field (clears as the user types).
  const [grantEmailError, setGrantEmailError] = useState<string | null>(null);
  const [grantTransportError, setGrantTransportError] = useState<string | null>(
    null,
  );
  const grantTransportErrorRef = useRef<HTMLDivElement>(null);
  // Track load failures so a failed fetch isn't rendered as a genuine empty list.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PaidMember | null>(null);

  // Debounce the email input so a full-registry server search (SUB-050) fires
  // ~300ms after typing stops rather than on every keystroke.
  const [debouncedEmail, setDebouncedEmail] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedEmail(emailQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [emailQuery]);
  // A changed status/email filter starts over at page 1.
  useEffect(() => {
    setPage(1);
  }, [filter, debouncedEmail]);

  // Only the newest request may write state. `debouncedEmail` changes as the
  // operator types and `page`/`filter` change on click, so several requests can
  // be in flight at once — and responses are not ordered. Without this, a
  // slower earlier response overwrites the newer one and the table shows rows
  // for a search the operator has already moved past.
  const membersGate = useRef(createLatestRequestGate()).current;

  const refresh = useCallback(async () => {
    const isCurrent = membersGate.begin();
    setBusy(true);
    setLoadError(null);
    try {
      const r = await listPaidMembers(
        filter || undefined,
        page,
        50,
        debouncedEmail || undefined,
      );
      if (!isCurrent()) return;
      // A payload without `members` left state as undefined and the render's
      // `.map` threw. Keep the array invariant at the boundary that owns it.
      setMembers(Array.isArray(r.members) ? r.members : []);
      setTotal(r.total);
    } catch (err) {
      if (!isCurrent()) return;
      const message =
        err instanceof Error ? err.message : "Could not load paid members.";
      // Persist the error so the table shows an error+retry state, not "No paid members yet".
      setLoadError(message);
      toast.error(message);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [filter, page, debouncedEmail, membersGate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (grantTransportError) grantTransportErrorRef.current?.focus();
  }, [grantTransportError]);

  // The backend now filters by email across the whole registry (SUB-050), so
  // the rendered rows are the server result directly.
  const visibleMembers = members;
  const hasMemberFilters = Boolean(filter || debouncedEmail);

  const clearMemberFilters = () => {
    setFilter("");
    setEmailQuery("");
    // Do not leave the old debounced query active for another 300 ms after an
    // explicit Clear. That would briefly re-fetch and re-render the state the
    // operator just asked to leave.
    setDebouncedEmail("");
    setPage(1);
  };

  const grant = async () => {
    if (grantingRef.current) return;
    const email = grantEmail.trim();
    // Pre-validate before the round-trip so a malformed address (e.g. "abc")
    // fails fast inline and KEEPS the input, instead of a generic server toast.
    if (!email) {
      setGrantEmailError("Email is required.");
      return;
    }
    if (!EMAIL_RE.test(email)) {
      setGrantEmailError("Enter a valid email address.");
      return;
    }
    setGrantEmailError(null);
    setGrantTransportError(null);
    grantingRef.current = true;
    // React may batch the visual state update until the event completes. Mark
    // the live mutation surface immediately so assistive technology receives
    // the pending state in the same task as the guarded request starts.
    grantSurfaceRef.current?.setAttribute("aria-busy", "true");
    setGranting(true);
    try {
      await grantPaidMember({
        subscriber_email: email,
        tier: grantTier.trim() || undefined,
      });
      toast.success(`Granted paid access to ${email}.`);
      setGrantEmail("");
      setGrantTier("");
      void refresh();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not grant access.";
      setGrantTransportError(message);
      toast.error(message);
    } finally {
      grantingRef.current = false;
      grantSurfaceRef.current?.removeAttribute("aria-busy");
      setGranting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / 50));

  return (
    <PageShell className="max-w-4xl">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Paid members
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manual paid-content access registry. Grant or revoke access here;
          connected payment-provider subscriptions are not synchronized into
          this registry automatically.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Grant paid access</CardTitle>
          <CardDescription>
            Use this to comp a subscriber, migrate paid members from another
            platform, or recover from a failed Stripe webhook.
          </CardDescription>
        </CardHeader>
        <CardContent
          ref={grantSurfaceRef}
          className="space-y-3"
          aria-busy={granting || undefined}
        >
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="grant-email">Email</Label>
              <Input
                id="grant-email"
                type="email"
                disabled={granting}
                value={grantEmail}
                onChange={(e) => {
                  setGrantEmail(e.target.value);
                  if (grantEmailError) setGrantEmailError(null);
                  if (grantTransportError) setGrantTransportError(null);
                }}
                placeholder="reader@example.com"
                aria-invalid={grantEmailError ? true : undefined}
                aria-describedby={
                  grantEmailError ? "grant-email-error" : undefined
                }
              />
              {grantEmailError && (
                <p
                  id="grant-email-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {grantEmailError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grant-tier">Tier (optional)</Label>
              <Input
                id="grant-tier"
                disabled={granting}
                value={grantTier}
                onChange={(e) => setGrantTier(e.target.value)}
                placeholder="Pro"
              />
            </div>
          </div>
          {grantTransportError ? (
            <Alert
              ref={grantTransportErrorRef}
              tabIndex={-1}
              variant="destructive"
            >
              <AlertDescription>{grantTransportError}</AlertDescription>
            </Alert>
          ) : null}
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            onClick={grant}
            disabled={granting}
          >
            {granting ? "Granting…" : "Grant paid access"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              {total} {hasMemberFilters ? "matching " : ""}
              {total === 1 ? "member" : "members"}
            </CardDescription>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                className="w-full pl-8 pr-8 sm:w-56"
                aria-label="Filter members by email"
                placeholder="Filter by email"
                value={emailQuery}
                onChange={(e) => setEmailQuery(e.target.value)}
              />
              {emailQuery ? (
                <button
                  type="button"
                  aria-label="Clear email filter"
                  onClick={() => setEmailQuery("")}
                  className="absolute right-0 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-1 sm:size-8"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <Select
              aria-label="Filter members by status"
              className="sm:w-40"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "" ? "All statuses" : s}
                </option>
              ))}
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div
            role="region"
            aria-label="Paid members"
            tabIndex={0}
            className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left">
                    Email
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Tier
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Started
                  </th>
                  <th scope="col" className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {/* Skeleton rows while fetching — an empty tbody with "0 members"
                    read as a real empty list. */}
                {busy
                  ? Array.from({ length: 5 }).map((_, i) => (
                      <tr key={`pm-sk-${i}`} aria-hidden>
                        <td className="px-3 py-2.5">
                          <Skeleton className="h-4 w-48" />
                        </td>
                        <td className="px-3 py-2.5">
                          <Skeleton className="h-5 w-16 rounded" />
                        </td>
                        <td className="px-3 py-2.5">
                          <Skeleton className="h-4 w-10" />
                        </td>
                        <td className="px-3 py-2.5">
                          <Skeleton className="h-4 w-20" />
                        </td>
                        <td className="px-3 py-2.5">
                          <Skeleton className="ml-auto h-8 w-16" />
                        </td>
                      </tr>
                    ))
                  : visibleMembers.map((m) => (
                      <tr key={m.subscriber_email}>
                        <td className="px-3 py-2 font-mono text-xs">
                          <Link
                            href={`/app/subscribers/${encodeURIComponent(
                              m.subscriber_email,
                            )}`}
                            className="inline-flex min-h-11 items-center rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
                          >
                            {m.subscriber_email}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              m.status === "active"
                                ? "rounded bg-success/15 px-1.5 py-0.5 text-xs text-success-emphasis"
                                : m.status === "canceled"
                                  ? "rounded bg-muted/60 px-1.5 py-0.5 text-xs text-muted-foreground"
                                  : "rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning-emphasis"
                            }
                          >
                            {m.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {m.tier ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {formatListDate(m.started_at)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditing(m)}
                            >
                              Edit
                            </Button>
                            {m.status !== "canceled" && (
                              <RevokePaidMemberDialog
                                email={m.subscriber_email}
                                onRevoked={() => void refresh()}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                {/* Surface a load failure explicitly with a Retry, instead of the misleading empty state. */}
                {loadError && !busy && (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center">
                      <p className="text-sm text-muted-foreground">
                        Couldn&apos;t load paid members: {loadError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => void refresh()}
                      >
                        Retry
                      </Button>
                    </td>
                  </tr>
                )}
                {/* No members loaded at all — only a first-run state when no
                    server-side filter is active. A filtered zero is not an
                    empty registry. */}
                {!loadError &&
                  !busy &&
                  members.length === 0 &&
                  !hasMemberFilters && (
                    <tr>
                      <td colSpan={5} className="px-0 py-4">
                        <EmptyState
                          icon={CreditCard}
                          title="No paid members yet"
                          description="Grant paid-content access to comp a reader, migrate members from another platform, or recover a failed webhook."
                        />
                      </td>
                    </tr>
                  )}
                {/* The endpoint already returns only matches, so a filtered
                    zero necessarily has an empty `members` array. */}
                {!loadError &&
                  !busy &&
                  members.length === 0 &&
                  hasMemberFilters && (
                    <tr>
                      <td colSpan={5} className="px-0 py-4">
                        <EmptyState
                          icon={Search}
                          title="No paid members match these filters"
                          description="Try another email or status, or clear the filters to return to the full paid-member registry."
                          action={
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11 sm:min-h-9"
                              onClick={clearMemberFilters}
                            >
                              Clear filters
                            </Button>
                          }
                        />
                      </td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
          {total > 50 ? (
            <div className="flex items-center justify-between border-t p-3 text-sm text-muted-foreground">
              <span>
                Page {page} of {totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || page === 1}
                  onClick={() => setPage((current) => current - 1)}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || page * 50 >= total}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <EditMemberDialog
        member={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void refresh();
        }}
      />
    </PageShell>
  );
}

function EditMemberDialog({
  member,
  onClose,
  onSaved,
}: {
  member: PaidMember | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState<string>("active");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (member) {
      setTier(member.tier ?? "");
      setStatus(member.status);
      setSaveError(null);
    }
  }, [member]);

  useEffect(() => {
    if (saveError) saveErrorRef.current?.focus();
  }, [saveError]);

  const save = async () => {
    if (!member || savingRef.current) return;
    setSaveError(null);
    savingRef.current = true;
    setSaving(true);
    try {
      // POST /paid-members upserts by email — reuse it to change tier/status.
      await grantPaidMember({
        subscriber_email: member.subscriber_email,
        tier: tier.trim() || undefined,
        status,
      });
      toast.success(`Updated ${member.subscriber_email}.`);
      onSaved();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not update member.";
      setSaveError(message);
      toast.error(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const unchanged = Boolean(
    member && tier.trim() === (member.tier ?? "") && status === member.status,
  );

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(next) => {
        if (!next && !savingRef.current) onClose();
      }}
    >
      <DialogContent
        aria-busy={saving}
        onEscapeKeyDown={(event) => {
          if (savingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (savingRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit paid member</DialogTitle>
          <DialogDescription>
            Change this member&apos;s paid-content tier or access status.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1.5">
            <Label>Email</Label>
            <p className="font-mono text-sm text-muted-foreground">
              {member?.subscriber_email}
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-tier">Tier</Label>
            <Input
              id="edit-tier"
              disabled={saving}
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              placeholder="Pro"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-status">Status</Label>
            <Select
              id="edit-status"
              disabled={saving}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {EDITABLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          {saveError ? (
            <Alert ref={saveErrorRef} tabIndex={-1} variant="destructive">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving || unchanged}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevokePaidMemberDialog({
  email,
  onRevoked,
}: {
  email: string;
  onRevoked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const revoke = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await revokePaidMember(email);
      toast.success(`Revoked paid access for ${email}.`);
      setOpen(false);
      onRevoked();
    } catch (revokeError) {
      const message =
        revokeError instanceof Error
          ? revokeError.message
          : "Could not revoke access.";
      setError(message);
      toast.error(message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingRef.current) return;
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
        >
          Revoke
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-busy={pending}
        onEscapeKeyDown={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pendingRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Revoke paid access?</DialogTitle>
          <DialogDescription>
            {email} will lose paid-content access. You can re-grant it later.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert ref={errorRef} tabIndex={-1} variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => void revoke()}
          >
            {pending ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
