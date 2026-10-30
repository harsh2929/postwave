// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { newWriteKey } from "@/lib/audience-admin-api";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  updateList,
  type AudienceList,
  type ListUpdateInput,
} from "@/lib/lists-api";

import {
  assertWriteIdentity,
  SETTINGS_REASON,
  SETTINGS_ROLES,
} from "./write-identity";

interface Draft {
  name: string;
  type: AudienceList["type"];
  optin: AudienceList["optin"];
  description: string;
  tags: string;
}

function draftFrom(list: AudienceList): Draft {
  return {
    name: list.name,
    type: list.type,
    optin: list.optin,
    description: list.description,
    tags: list.tags.join(", "),
  };
}

function draftsEqual(a: Draft, b: Draft): boolean {
  return (
    a.name === b.name &&
    a.type === b.type &&
    a.optin === b.optin &&
    a.description === b.description &&
    a.tags === b.tags
  );
}

/** The PATCH whitelist body, exactly as the gateway accepts it. */
export function settingsBody(draft: Draft): ListUpdateInput {
  return {
    name: draft.name.trim(),
    type: draft.type,
    optin: draft.optin,
    description: draft.description.trim(),
    tags: draft.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

export function ListSettingsTab({
  list,
  me,
  canWrite,
  onSaved,
}: {
  list: AudienceList;
  me: MeResponse | undefined;
  canWrite: boolean;
  onSaved: () => Promise<void>;
}) {
  const ids = useId();
  const baselineRef = useRef<Draft>(draftFrom(list));
  const [baseline, setBaseline] = useState<Draft>(baselineRef.current);
  const [draft, setDraft] = useState<Draft>(baselineRef.current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A refetched record replaces an untouched draft; an in-progress edit is
  // kept so a background refresh never wipes what the operator typed.
  useEffect(() => {
    const next = draftFrom(list);
    const previous = baselineRef.current;
    baselineRef.current = next;
    setBaseline(next);
    setDraft((current) => (draftsEqual(current, previous) ? next : current));
  }, [list]);

  const dirty = !draftsEqual(draft, baseline);
  const blocked = !canWrite
    ? SETTINGS_REASON
    : saving
      ? "Wait for the current save to finish."
      : !dirty
        ? "There are no unsaved changes."
        : null;

  async function save(): Promise<void> {
    if (blocked || !me) return;
    const body = settingsBody(draft);
    if (!body.name || body.name.length > 200) {
      setError("Name must be 1–200 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      assertWriteIdentity(
        me,
        await whoamiFresh(),
        SETTINGS_ROLES,
        "Editor access is required.",
      );
      await updateList(list.id, body, newWriteKey("list-update"));
      await onSaved();
      if (!mounted.current) return;
      const acknowledged: Draft = {
        ...draft,
        name: body.name,
        description: body.description,
        tags: body.tags.join(", "),
      };
      baselineRef.current = acknowledged;
      setBaseline(acknowledged);
      setDraft(acknowledged);
      toast.success(`List "${body.name}" updated`);
    } catch (e) {
      if (mounted.current)
        setError(apiErrorMessage(e, "List settings could not be saved"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const readOnly = !canWrite || saving;

  return (
    <form
      className="grid max-w-2xl gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!canWrite ? (
        <p id={`${ids}-reason`} className="text-xs text-muted-foreground">
          {SETTINGS_REASON}
        </p>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-name`}>Name</Label>
        <Input
          id={`${ids}-name`}
          maxLength={200}
          value={draft.name}
          disabled={readOnly}
          aria-describedby={canWrite ? undefined : `${ids}-reason`}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-type`}>Visibility</Label>
          <Select
            id={`${ids}-type`}
            value={draft.type}
            disabled={readOnly}
            aria-describedby={canWrite ? undefined : `${ids}-reason`}
            onChange={(e) =>
              setDraft({
                ...draft,
                type: e.target.value as AudienceList["type"],
              })
            }
          >
            <option value="private">Private</option>
            <option value="public">Public</option>
            <option value="temporary">Temporary</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            Private lists are admin-managed; public lists appear on hosted
            preference pages.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-optin`}>Opt-in</Label>
          <Select
            id={`${ids}-optin`}
            value={draft.optin}
            disabled={readOnly}
            aria-describedby={canWrite ? undefined : `${ids}-reason`}
            onChange={(e) =>
              setDraft({
                ...draft,
                optin: e.target.value as AudienceList["optin"],
              })
            }
          >
            <option value="single">Single</option>
            <option value="double">Double</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            Double sends a confirmation email before a subscription is live.
          </p>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-tags`}>Tags (comma-separated)</Label>
        <Input
          id={`${ids}-tags`}
          value={draft.tags}
          placeholder="vip, newsletter"
          disabled={readOnly}
          aria-describedby={canWrite ? undefined : `${ids}-reason`}
          onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-description`}>Description</Label>
        <Textarea
          id={`${ids}-description`}
          maxLength={2000}
          value={draft.description}
          disabled={readOnly}
          aria-describedby={canWrite ? undefined : `${ids}-reason`}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {canWrite && blocked ? (
        <p id={`${ids}-blocked`} className="text-xs text-muted-foreground">
          {blocked}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={saving || !dirty}
          onClick={() => {
            setDraft(baselineRef.current);
            setError(null);
          }}
        >
          Reset
        </Button>
        <Button
          type="submit"
          disabled={Boolean(blocked)}
          loading={saving}
          aria-describedby={
            blocked
              ? canWrite
                ? `${ids}-blocked`
                : `${ids}-reason`
              : undefined
          }
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
