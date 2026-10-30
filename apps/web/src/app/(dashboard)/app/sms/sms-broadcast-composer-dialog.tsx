// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { listTags } from "@/lib/audience-admin-api";
import { STALE } from "@/lib/query-keys";
import type { Segment } from "@/lib/segments-api";
import {
  listSmsSenders,
  type SmsBroadcast,
  type SmsBroadcastUpsert,
  type SmsList,
  type SmsSenderProfile,
} from "@/lib/sms-api";
import {
  SMS_BROADCAST_SEGMENT_CAP,
  buildSmsBroadcastUpsert,
  emptySmsBroadcastForm,
  smsBroadcastErrorCode,
  smsBroadcastFieldForErrorCode,
  smsBroadcastFormFrom,
  smsBroadcastSegmentInfo,
  validateSmsBroadcastForm,
  type SmsBroadcastAudienceKind,
  type SmsBroadcastFormField,
  type SmsBroadcastFormState,
} from "./sms-broadcast-helpers";

const AUDIENCE_OPTIONS: ReadonlyArray<{
  value: SmsBroadcastAudienceKind;
  label: string;
}> = [
  { value: "lists", label: "SMS lists" },
  { value: "segment", label: "Segment" },
  { value: "tag", label: "Tag" },
];

function senderLabel(sender: SmsSenderProfile): string {
  const identity =
    sender.phone_number || sender.messaging_service_sid || sender.id;
  return `${identity} · ${sender.provider} · ${sender.registration_status}`;
}

interface SmsBroadcastComposerDialogProps {
  /** Null = create; a row = edit (server allows draft|scheduled only). */
  existing: SmsBroadcast | null;
  lists: SmsList[];
  segments: Segment[];
  segmentsError: string | null;
  baseKey: readonly unknown[];
  onClose: () => void;
  /** Performs the create/PATCH; a thrown error is rendered verbatim inline. */
  onSave: (input: SmsBroadcastUpsert) => Promise<void>;
}

/**
 * Create / edit an SMS broadcast definition. Saving stores an editable draft;
 * it never sends or schedules — server dispatch is release-held and this page
 * offers no send verb, so the copy says exactly that.
 */
export function SmsBroadcastComposerDialog({
  existing,
  lists,
  segments,
  segmentsError,
  baseKey,
  onClose,
  onSave,
}: SmsBroadcastComposerDialogProps) {
  const ids = useId();
  const [form, setForm] = useState<SmsBroadcastFormState>(() =>
    existing ? smsBroadcastFormFrom(existing) : emptySmsBroadcastForm(),
  );
  const [errors, setErrors] = useState<
    Partial<Record<SmsBroadcastFormField, string>>
  >({});
  const [saving, setSaving] = useState(false);

  const sendersKey = useMemo(
    () => [...baseKey, "broadcast-senders"] as const,
    [baseKey],
  );
  const sendersQuery = useQuery({
    queryKey: sendersKey,
    queryFn: () => listSmsSenders(),
    staleTime: STALE.list,
  });
  const tagsKey = useMemo(
    () => [...baseKey, "broadcast-tags"] as const,
    [baseKey],
  );
  const tagsQuery = useQuery({
    queryKey: tagsKey,
    queryFn: ({ signal }) => listTags({ signal }),
    enabled: form.audience === "tag",
    staleTime: STALE.list,
  });

  const isEdit = existing !== null;
  const segmentInfo = smsBroadcastSegmentInfo(form.body);
  const senders = Array.isArray(sendersQuery.data?.items)
    ? sendersQuery.data.items
    : [];
  const tagSuggestions = Array.isArray(tagsQuery.data) ? tagsQuery.data : [];

  const patch = (next: Partial<SmsBroadcastFormState>) =>
    setForm((current) => ({ ...current, ...next }));
  const toggleList = (id: string) =>
    setForm((current) => ({
      ...current,
      listIds: current.listIds.includes(id)
        ? current.listIds.filter((entry) => entry !== id)
        : [...current.listIds, id],
    }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const clientErrors = validateSmsBroadcastForm(form);
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await onSave(buildSmsBroadcastUpsert(form));
    } catch (error: unknown) {
      // The server's own sentence, placed on the field its code names.
      setErrors({
        [smsBroadcastFieldForErrorCode(smsBroadcastErrorCode(error))]:
          apiErrorMessage(error, "The broadcast could not be saved."),
      });
    } finally {
      setSaving(false);
    }
  };

  const errorId = (field: SmsBroadcastFormField) =>
    errors[field] ? `${ids}-${field}-error` : undefined;
  const fieldError = (field: SmsBroadcastFormField) =>
    errors[field] ? (
      <p
        id={`${ids}-${field}-error`}
        role="alert"
        className="text-sm text-destructive"
      >
        {errors[field]}
      </p>
    ) : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        closeDisabled={saving}
        className="max-h-[90vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${existing.name}` : "New SMS broadcast"}
          </DialogTitle>
          <DialogDescription>
            Saving stores an editable definition. It does not send or schedule a
            message: broadcast dispatch is release-held on the server and this
            page makes no dispatch request.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-name`}>Name</Label>
            <Input
              id={`${ids}-name`}
              value={form.name}
              maxLength={256}
              required
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errorId("name")}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="June flash sale"
            />
            {fieldError("name")}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-sender`}>From sender</Label>
            <Select
              id={`${ids}-sender`}
              value={form.senderProfileId}
              aria-invalid={Boolean(errors.sender)}
              aria-describedby={errorId("sender")}
              disabled={sendersQuery.isPending}
              onChange={(event) =>
                patch({ senderProfileId: event.target.value })
              }
            >
              <option value="">
                {sendersQuery.isPending
                  ? "Loading senders…"
                  : sendersQuery.isError
                    ? "Senders could not be verified"
                    : senders.length === 0
                      ? "No sender profiles yet"
                      : "Optional while drafting"}
              </option>
              {senders.map((sender) => (
                <option key={sender.id} value={sender.id}>
                  {senderLabel(sender)}
                </option>
              ))}
            </Select>
            {sendersQuery.isError ? (
              <p role="status" className="text-xs text-muted-foreground">
                Sender profiles could not be loaded:{" "}
                {apiErrorMessage(sendersQuery.error)}. A stored sender id is
                kept as-is.
              </p>
            ) : null}
            {fieldError("sender")}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-body`}>Message</Label>
            <Textarea
              id={`${ids}-body`}
              value={form.body}
              rows={4}
              maxLength={4800}
              required
              aria-invalid={Boolean(errors.body)}
              aria-describedby={`${ids}-segments${errors.body ? ` ${ids}-body-error` : ""}`}
              onChange={(event) => patch({ body: event.target.value })}
              placeholder="Type the broadcast message…"
            />
            <p
              id={`${ids}-segments`}
              className="text-xs tabular-nums text-muted-foreground"
            >
              {segmentInfo.units.toLocaleString()} units ·{" "}
              {segmentInfo.segments} segment
              {segmentInfo.segments === 1 ? "" : "s"} · {segmentInfo.remaining}{" "}
              left in segment
              {segmentInfo.encoding === "ucs2"
                ? " · unicode (70-unit segments)"
                : ""}{" "}
              · max {SMS_BROADCAST_SEGMENT_CAP} segments. Carriers bill per
              segment, per recipient.
            </p>
            {fieldError("body")}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Audience</legend>
            <p className="text-xs text-muted-foreground">
              A broadcast targets exactly one audience type.
            </p>
            <div
              role="radiogroup"
              aria-label="Audience type"
              className="flex flex-wrap gap-4"
            >
              {AUDIENCE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name={`${ids}-audience`}
                    value={option.value}
                    checked={form.audience === option.value}
                    onChange={() => patch({ audience: option.value })}
                    className="accent-primary"
                  />
                  {option.label}
                </label>
              ))}
            </div>

            {form.audience === "lists" ? (
              lists.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No SMS lists yet. Create one under Audience first, then target
                  it here.
                </p>
              ) : (
                <div
                  className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2"
                  role="group"
                  aria-label="SMS lists"
                >
                  {lists.map((list) => (
                    <label
                      key={list.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={form.listIds.includes(list.id)}
                        onChange={() => toggleList(list.id)}
                        aria-label={`Target ${list.name}`}
                      />
                      <span>{list.name}</span>
                      {list.keyword ? (
                        <span className="text-xs text-muted-foreground">
                          keyword {list.keyword}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              )
            ) : null}

            {form.audience === "segment" ? (
              segmentsError ? (
                <p role="alert" className="text-sm text-destructive">
                  Segments could not be loaded: {segmentsError}
                </p>
              ) : segments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No segments available. Create one under Subscribers → Segments
                  first.
                </p>
              ) : (
                <Select
                  aria-label="Segment"
                  value={form.segmentId}
                  onChange={(event) => patch({ segmentId: event.target.value })}
                >
                  <option value="">Pick a segment…</option>
                  {segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segment.name}
                      {typeof segment.lastCount === "number"
                        ? ` (${segment.lastCount.toLocaleString()})`
                        : ""}
                    </option>
                  ))}
                </Select>
              )
            ) : null}

            {form.audience === "tag" ? (
              <>
                <Input
                  aria-label="Tag"
                  list={`${ids}-tag-options`}
                  value={form.tag}
                  maxLength={64}
                  onChange={(event) => patch({ tag: event.target.value })}
                  placeholder="vip"
                />
                <datalist id={`${ids}-tag-options`}>
                  {tagSuggestions.map((tag) => (
                    <option key={tag.id} value={tag.name} />
                  ))}
                </datalist>
                {tagsQuery.isError ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    Tag suggestions are unavailable:{" "}
                    {apiErrorMessage(tagsQuery.error)}. You can still enter an
                    exact tag; the server verifies it when the draft is saved.
                  </p>
                ) : null}
              </>
            ) : null}
            {fieldError("audience")}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-schedule`}>Schedule (optional)</Label>
            <Input
              id={`${ids}-schedule`}
              type="datetime-local"
              value={form.scheduledAtLocal}
              aria-invalid={Boolean(errors.schedule)}
              aria-describedby={`${ids}-schedule-hint${errors.schedule ? ` ${ids}-schedule-error` : ""}`}
              onChange={(event) =>
                patch({ scheduledAtLocal: event.target.value })
              }
            />
            <p
              id={`${ids}-schedule-hint`}
              className="text-xs text-muted-foreground"
            >
              Saving a time keeps the broadcast as an editable definition.
              Nothing is armed from this page.
            </p>
            {fieldError("schedule")}
          </div>

          {fieldError("_form")}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-10"
              disabled={saving}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button type="submit" className="min-h-10" loading={saving}>
              {isEdit ? "Save changes" : "Create draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
