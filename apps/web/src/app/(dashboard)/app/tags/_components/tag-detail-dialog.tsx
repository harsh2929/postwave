// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  newWriteKey,
  tagHistory,
  tagMembership,
  updateTag,
  type Membership,
  type TagRecord,
} from "@/lib/audience-admin-api";
import { STALE, tagKeys, type RoleKey } from "@/lib/query-keys";
import {
  isTagVersionConflict,
  listSubscribersWithTag,
  TAG_SUBSCRIBER_SAMPLE_LIMIT,
} from "@/lib/tags-api";
import { runeLength, tagColorPresentation } from "../tag-catalogue-model";
import { TagSwatch } from "./tag-color-palette";

const MEMBERSHIP_WINDOWS = [30, 90] as const;

/**
 * The tag detail: membership over 30/90 days, a verified sample of the
 * subscribers carrying the tag (each opens in Subscribers), an inline
 * description edit against the tag's exact ETag, and the audit history.
 */
export function TagDetailDialog({
  tag,
  count,
  tenantId,
  role,
  canWrite,
  authorize,
  onClose,
  onUpdated,
  onConflict,
}: {
  /** The current registry row (fresh ETag); null closes the dialog. */
  tag: TagRecord | null;
  /** Total membership when known; null renders as unverified. */
  count: number | null;
  tenantId: string;
  role: RoleKey;
  canWrite: boolean;
  authorize: () => Promise<void>;
  onClose: () => void;
  onUpdated: (next: TagRecord) => Promise<void> | void;
  onConflict: () => Promise<void> | void;
}) {
  const [days, setDays] = useState<(typeof MEMBERSHIP_WINDOWS)[number]>(30);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const tagId = tag?.id ?? "";
  const tagName = tag?.name ?? "";
  const serverDescription = tag?.description ?? "";
  // Seed the draft once per tag. The catalogue reload after a 412 hands us a
  // fresh row for the SAME tag — possibly with a description changed
  // elsewhere — and that must not clobber what the operator typed: they see
  // the conflict toast, keep their draft, and save again against the new ETag.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededFor.current === tagId) return;
    seededFor.current = tagId;
    setDraft(serverDescription);
    setDays(30);
  }, [tagId, serverDescription]);

  const membership = useQuery({
    queryKey: tagKeys.membership(tenantId, role, tagId, days),
    queryFn: ({ signal }) => tagMembership(tagId, days, signal),
    enabled: Boolean(tag),
    staleTime: STALE.detail,
    retry: false,
  });
  const subscribers = useQuery({
    queryKey: tagKeys.subscribers(tenantId, role, tagName),
    queryFn: ({ signal }) =>
      listSubscribersWithTag(tagName, TAG_SUBSCRIBER_SAMPLE_LIMIT, signal),
    enabled: Boolean(tag),
    staleTime: STALE.detail,
    retry: false,
  });
  const history = useQuery({
    queryKey: tagKeys.history(tenantId, role, tagId),
    queryFn: ({ signal }) => tagHistory(tagId, signal),
    enabled: Boolean(tag),
    staleTime: STALE.detail,
  });

  const dirty = draft !== serverDescription;
  async function saveDescription() {
    if (!tag || !dirty || saving) return;
    setSaving(true);
    try {
      await authorize();
      if (runeLength(draft) > 1024)
        throw new Error("Description must be at most 1,024 characters.");
      const next = await updateTag(
        tag,
        { description: draft },
        newWriteKey("tag-describe"),
      );
      toast.success("Description saved");
      await onUpdated(next);
    } catch (e) {
      if (isTagVersionConflict(e)) {
        toast.error(
          "This tag changed elsewhere. Your description draft was kept while the latest version reloads.",
        );
        await onConflict();
      } else toast.error(apiErrorMessage(e, "Description could not be saved"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const colour = tagColorPresentation(tag?.color);
  return (
    <Dialog
      open={tag !== null}
      onOpenChange={(v) => !v && !saving && onClose()}
    >
      <DialogContent closeDisabled={saving} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TagSwatch color={tag?.color} />
            {tagName}
            {colour.legacy ? (
              <Badge variant="warning" title={colour.label}>
                Legacy colour
              </Badge>
            ) : null}
            {tag?.pii ? <Badge variant="outline">PII</Badge> : null}
          </DialogTitle>
          <DialogDescription>
            Created {tag ? new Date(tag.created_at).toLocaleDateString() : "—"}{" "}
            ·{" "}
            {count === null
              ? "membership unverified"
              : `${count.toLocaleString()} subscriber${count === 1 ? "" : "s"}`}{" "}
            · v{tag?.version}
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="tag-detail-description"
          className="grid gap-2"
        >
          <Label
            id="tag-detail-description"
            htmlFor="tag-detail-description-field"
          >
            Description
          </Label>
          <Textarea
            id="tag-detail-description-field"
            rows={3}
            maxLength={1024}
            value={draft}
            disabled={!canWrite || saving}
            placeholder="What does this tag mean? Who should get it?"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {runeLength(draft).toLocaleString()} / 1,024
              {canWrite ? "" : " · Editor access is required to edit."}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!dirty || saving}
                onClick={() => setDraft(serverDescription)}
              >
                Reset
              </Button>
              <Button
                size="sm"
                disabled={!dirty || saving || !canWrite}
                onClick={saveDescription}
              >
                {saving ? "Saving…" : "Save description"}
              </Button>
            </div>
          </div>
        </section>

        <section aria-label="Membership history" className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              Membership · last {days} days
            </h3>
            <div
              role="group"
              aria-label="Membership window"
              className="flex gap-1"
            >
              {MEMBERSHIP_WINDOWS.map((w) => (
                <Button
                  key={w}
                  size="sm"
                  variant={w === days ? "secondary" : "ghost"}
                  aria-pressed={w === days}
                  onClick={() => setDays(w)}
                >
                  {w} days
                </Button>
              ))}
            </div>
          </div>
          {membership.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(
                membership.error,
                "Membership history could not be loaded",
              )}{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void membership.refetch()}
              >
                Retry
              </Button>
            </p>
          ) : membership.isPending ? (
            <p role="status" className="text-sm">
              Loading membership…
            </p>
          ) : (
            <MembershipSummary data={membership.data} days={days} />
          )}
        </section>

        <section aria-labelledby="tag-detail-members" className="grid gap-2">
          <h3 id="tag-detail-members" className="text-sm font-medium">
            Subscribers with this tag
          </h3>
          <p className="text-xs text-muted-foreground">
            A tag-filtered Subscribers view is not available yet; open a
            subscriber below instead. The server returns the{" "}
            {TAG_SUBSCRIBER_SAMPLE_LIMIT} most recently tagged.
          </p>
          {subscribers.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(
                subscribers.error,
                "Subscribers for this tag could not be loaded",
              )}{" "}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void subscribers.refetch()}
              >
                Retry
              </Button>
            </p>
          ) : subscribers.isPending ? (
            <p role="status" className="text-sm">
              Loading subscribers…
            </p>
          ) : subscribers.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No subscribers carry this tag.
            </p>
          ) : (
            <ul className="max-h-56 divide-y overflow-auto rounded-md border text-sm">
              {subscribers.data.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <Link
                    href={`/app/subscribers/${encodeURIComponent(s.id)}`}
                    className="truncate underline-offset-4 hover:underline"
                    aria-label={`Open ${s.email} in Subscribers`}
                  >
                    {s.email}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {s.status || "—"}
                  </span>
                </li>
              ))}
              {count !== null && count > TAG_SUBSCRIBER_SAMPLE_LIMIT ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">
                  {(count - TAG_SUBSCRIBER_SAMPLE_LIMIT).toLocaleString()} more
                  not shown.
                </li>
              ) : null}
            </ul>
          )}
        </section>

        <section aria-labelledby="tag-detail-history" className="grid gap-2">
          <h3 id="tag-detail-history" className="text-sm font-medium">
            Recent audit events
          </h3>
          {history.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(history.error, "History could not be loaded")}
            </p>
          ) : history.isPending ? (
            <p role="status" className="text-sm">
              Loading history…
            </p>
          ) : history.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-auto text-sm">
              {history.data.map((x) => (
                <li key={x.id} className="border-b pb-1 last:border-0">
                  <strong>{x.action}</strong> via {x.source} ·{" "}
                  {new Date(x.occurred_at).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function MembershipSummary({ data, days }: { data: Membership; days: number }) {
  const complete = data.coverage.requested_window_complete;
  const max = Math.max(1, ...data.daily.map((b) => Math.abs(b.net)));
  return (
    <div className="grid gap-2">
      <dl
        className="grid grid-cols-3 gap-2 text-sm"
        aria-label="Membership summary"
      >
        <div className="rounded-md border p-2">
          <dt className="text-xs text-muted-foreground">Current</dt>
          <dd className="font-medium tabular-nums">
            {data.current_count.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border p-2">
          <dt className="text-xs text-muted-foreground">
            {complete ? "Joined" : "Joined in covered period"}
          </dt>
          <dd className="font-medium tabular-nums text-success-emphasis">
            {data.added.toLocaleString()}
          </dd>
        </div>
        <div className="rounded-md border p-2">
          <dt className="text-xs text-muted-foreground">
            {complete ? "Left" : "Left in covered period"}
          </dt>
          <dd className="font-medium tabular-nums text-destructive-emphasis">
            {data.removed.toLocaleString()}
          </dd>
        </div>
      </dl>
      <p role="note" className="text-xs text-muted-foreground">
        {complete
          ? `Exact for the requested ${days}-day window.`
          : `Coverage began inside this ${days}-day window; earlier membership is unknown.`}{" "}
        As of {new Date(data.coverage.as_of).toLocaleString()}.
      </p>
      {data.daily.length > 0 ? (
        <div
          role="img"
          aria-label={`Daily net membership changes: ${data.added.toLocaleString()} joined and ${data.removed.toLocaleString()} left in the covered period.`}
          className="flex h-14 items-end gap-px"
        >
          {data.daily.map((b) => (
            <span
              key={b.date}
              title={`${b.date}: ${b.net > 0 ? "+" : ""}${b.net.toLocaleString()}`}
              className={
                b.net < 0 ? "flex-1 bg-destructive" : "flex-1 bg-primary"
              }
              style={{
                height: `${Math.max(2, Math.round((Math.abs(b.net) / max) * 100))}%`,
              }}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No joins or departures were recorded in the covered period.
        </p>
      )}
    </div>
  );
}
