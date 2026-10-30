// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage, isApiError } from "@/lib/api";
import {
  setSubscriberTags,
  SUBSCRIBER_TAG_LIMIT,
  type Subscriber,
} from "@/lib/subscriber-directory-api";

function tagError(error: unknown): string {
  if (isApiError(error) && (error.status === 412 || error.status === 428))
    return "This subscriber changed since the list loaded. Refresh before editing tags.";
  return apiErrorMessage(error, "Could not update tags.");
}

/**
 * Tags as chips on a directory row: remove with the chip's ×, add with +.
 * The server treats `tags` as a whole-array replace, so each change sends the
 * row's full intended set under its exact revision — never a partial list.
 */
export function InlineTagChips({
  subscriber,
  canWrite,
  onChanged,
}: {
  subscriber: Subscriber;
  canWrite: boolean;
  onChanged: (updated: Subscriber) => void;
}) {
  const inputId = useId();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const tags = Array.isArray(subscriber.tags) ? subscriber.tags : [];

  const write = async (next: string[], success: string) => {
    if (pending) return false;
    setPending(true);
    try {
      const updated = await setSubscriberTags(subscriber, next);
      onChanged(updated);
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(tagError(error));
      return false;
    } finally {
      setPending(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const tag = draft.trim();
    if (!tag) return;
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      toast.info(`${subscriber.email} already has “${tag}”.`);
      return;
    }
    if (await write([...tags, tag], `Tagged ${subscriber.email} “${tag}”.`)) {
      setDraft("");
      setAdding(false);
    }
  };

  const atLimit = tags.length >= SUBSCRIBER_TAG_LIMIT;

  return (
    <div className="flex flex-wrap items-center gap-1" aria-busy={pending}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 rounded-full border bg-muted/50 py-0.5 pl-2 pr-0.5 text-xs"
        >
          {tag}
          {canWrite ? (
            <button
              type="button"
              disabled={pending}
              aria-label={`Remove tag ${tag} from ${subscriber.email}`}
              className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              onClick={() =>
                void write(
                  tags.filter((existing) => existing !== tag),
                  `Removed “${tag}” from ${subscriber.email}.`,
                )
              }
            >
              <X aria-hidden className="h-3 w-3" />
            </button>
          ) : null}
        </span>
      ))}
      {tags.length === 0 && !adding ? (
        <span className="text-xs text-muted-foreground">No tags</span>
      ) : null}
      {canWrite && !adding ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs"
          disabled={pending || atLimit}
          title={atLimit ? `A subscriber can carry at most ${SUBSCRIBER_TAG_LIMIT} tags.` : undefined}
          aria-label={`Add a tag to ${subscriber.email}`}
          onClick={() => setAdding(true)}
        >
          <Plus aria-hidden className="h-3 w-3" />
          Tag
        </Button>
      ) : null}
      {canWrite && adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={add}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setAdding(false);
              setDraft("");
            }
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            New tag for {subscriber.email}
          </label>
          <Input
            id={inputId}
            autoFocus
            value={draft}
            maxLength={100}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            className="h-7 w-28 text-xs"
          />
          <Button type="submit" size="sm" className="h-7" disabled={!draft.trim() || pending}>
            Add
          </Button>
        </form>
      ) : null}
    </div>
  );
}
