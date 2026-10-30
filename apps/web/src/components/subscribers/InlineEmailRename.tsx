// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  normalizeRenamedEmail,
  renameSubscriberEmail,
  type Subscriber,
} from "@/lib/subscriber-directory-api";

function renameError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 412 || error.status === 428)
      return "This subscriber changed since the list loaded. Refresh before renaming.";
    if (error.code === "email_taken")
      return "Another subscriber already uses that address.";
  }
  return apiErrorMessage(error, "Could not rename this subscriber.");
}

/**
 * Rename a subscriber's email from its directory row: PATCH {email} under the
 * row's exact revision, with an Undo that PATCHes the previous address back
 * using the revision the rename returned. The same identity-rotation review
 * the detail editor requires is asked for here — a new address starts
 * without the old one's consent evidence.
 */
export function InlineEmailRename({
  subscriber,
  canWrite,
  onRenamed,
}: {
  subscriber: Subscriber;
  canWrite: boolean;
  onRenamed: (updated: Subscriber) => void;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(subscriber.email);
  const [reviewed, setReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(subscriber.email);
  }, [editing, subscriber.email]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        <MiddleTruncate value={subscriber.email} />
        {canWrite ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            aria-label={`Rename email for ${subscriber.email}`}
            onClick={() => {
              setError(null);
              setReviewed(false);
              setEditing(true);
            }}
          >
            <Pencil aria-hidden className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </span>
    );
  }

  const next = normalizeRenamedEmail(value);
  const unchanged = next === subscriber.email.toLowerCase();
  const blocked = !next
    ? "Enter a valid email address."
    : unchanged
      ? "Enter a different address."
      : !reviewed
        ? "Review the identity rotation first."
        : null;

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || saving || !next) return;
    setSaving(true);
    setError(null);
    const previous = subscriber.email;
    try {
      const updated = await renameSubscriberEmail(subscriber, next);
      onRenamed(updated);
      setEditing(false);
      toast.success(`Renamed to ${updated.email}.`, {
        action: {
          label: "Undo",
          onClick: () => {
            void renameSubscriberEmail(updated, previous)
              .then((reverted) => {
                onRenamed(reverted);
                toast.info(`Reverted to ${previous}.`);
              })
              .catch((undoError: unknown) => toast.error(renameError(undoError)));
          },
        },
      });
    } catch (err) {
      setError(renameError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="grid gap-1.5"
      onSubmit={save}
      noValidate
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        New email for {subscriber.email}
      </label>
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          id={inputId}
          type="email"
          maxLength={320}
          value={value}
          disabled={saving}
          onChange={(event) => {
            setValue(event.target.value);
            setReviewed(false);
          }}
          className="h-8"
        />
        <Button type="submit" size="sm" disabled={Boolean(blocked) || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={cancel}>
          Cancel
        </Button>
      </div>
      {next && !unchanged ? (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-primary"
            checked={reviewed}
            disabled={saving}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          <span>
            I reviewed this identity rotation. A new address starts without
            marketing consent; evidence is not copied from the old email.
          </span>
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
