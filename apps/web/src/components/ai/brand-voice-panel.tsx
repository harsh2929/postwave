// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Tenant-wide brand-voice profile editor (desktop BrandVoicePanel parity).
 *
 * Descriptors and writing rules are one per line; sample snippets are
 * separated by a blank line. Saving PUTs all three lists as one profile, and
 * is withheld for non-admins (the server requires the admin scope) and
 * whenever the saved lists could not be verified — a replacement seeded from
 * values the editor never showed would overwrite them.
 */
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import {
  BRAND_VOICE_LIMITS,
  BrandVoiceContractError,
  brandVoiceValidationError,
  saveBrandVoiceProfile,
  type BrandVoiceProfileFields,
  type BrandVoiceProfileRead,
} from "@/lib/brand-voice-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";

interface DraftTexts {
  descriptors: string;
  rules: string;
  snippets: string;
}

const EMPTY_FIELDS: BrandVoiceProfileFields = {
  descriptors: [],
  writingRules: [],
  sampleSnippets: [],
};

function lines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function snippets(text: string): string[] {
  return text
    .split(/\n\s*\n/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function textsFrom(fields: BrandVoiceProfileFields): DraftTexts {
  return {
    descriptors: fields.descriptors.join("\n"),
    rules: fields.writingRules.join("\n"),
    snippets: fields.sampleSnippets.join("\n\n"),
  };
}

function fieldsFrom(texts: DraftTexts): BrandVoiceProfileFields {
  return {
    descriptors: lines(texts.descriptors),
    writingRules: lines(texts.rules),
    sampleSnippets: snippets(texts.snippets),
  };
}

function snapshot(fields: BrandVoiceProfileFields): string {
  return JSON.stringify([
    fields.descriptors,
    fields.writingRules,
    fields.sampleSnippets,
  ]);
}

export function BrandVoicePanel({
  read,
  canEdit,
  queryKey,
}: {
  read: BrandVoiceProfileRead;
  /** Owner/admin outside viewer mode; the server PUT requires admin scope. */
  canEdit: boolean;
  /** The query the page reads the profile through; updated after a save. */
  queryKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const id = useId();
  const verified = !read.active || read.profile !== null;
  const baseline: BrandVoiceProfileFields = read.active
    ? (read.profile ?? EMPTY_FIELDS)
    : EMPTY_FIELDS;
  const baselineKey = snapshot(baseline);
  const [texts, setTexts] = useState<DraftTexts>(() => textsFrom(baseline));
  const [syncedKey, setSyncedKey] = useState(baselineKey);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // A newly verified server profile replaces the draft only when the draft
  // had no unsaved edits against the profile it was built from.
  if (syncedKey !== baselineKey) {
    const hadEdits = snapshot(fieldsFrom(texts)) !== syncedKey;
    setSyncedKey(baselineKey);
    if (!hadEdits) setTexts(textsFrom(baseline));
  }

  const mutation = useMutation({
    mutationFn: (fields: BrandVoiceProfileFields) =>
      saveBrandVoiceProfile(fields),
    onSuccess: (saved) => {
      setTexts(textsFrom(saved));
      setSyncedKey(snapshot(saved));
      queryClient.setQueryData<BrandVoiceProfileRead>(queryKey, {
        active: true,
        name: read.active ? read.name : null,
        profile: saved,
      });
      setError(null);
      setReceipt(
        "Brand voice profile saved. Supported AI compose and pre-send drift checks read it from now on.",
      );
    },
    onError: (cause) => {
      setReceipt(null);
      setError(
        apiErrorMessage(cause, "The brand voice profile was not saved."),
      );
      // A 2xx whose body could not be verified may already have committed.
      if (cause instanceof BrandVoiceContractError) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });

  if (!verified) {
    return (
      <p
        role="status"
        className="mt-3 rounded-lg border border-dashed p-3 text-sm text-muted-foreground"
      >
        The saved descriptors, rules, or samples could not be verified, so
        editing is paused. Refresh the workspace to read the profile again.
      </p>
    );
  }

  const fields = fieldsFrom(texts);
  const dirty = snapshot(fields) !== baselineKey;
  const validation = brandVoiceValidationError(fields);
  const saving = mutation.isPending;
  const readOnly = !canEdit || saving;
  const guidance = !canEdit
    ? "Admin access is required to edit this tenant-wide profile. The saved values remain readable."
    : saving
      ? "Saving this exact profile…"
      : !dirty
        ? read.active
          ? "The fields match the saved profile."
          : "No profile is saved yet. Saving creates it."
        : (validation ?? "Unsaved brand-voice changes are ready to save.");
  const L = BRAND_VOICE_LIMITS;
  const savedAt =
    read.active && read.profile?.updatedAt
      ? formatWireTimestamp(read.profile.updatedAt, "")
      : "";

  return (
    <form
      aria-label="Brand voice profile"
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canEdit || !dirty || validation || saving) return;
        setError(null);
        setReceipt(null);
        mutation.mutate(fields);
      }}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Profile not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {receipt ? (
        <Alert role="status">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{receipt}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label htmlFor={`${id}-descriptors`}>Descriptors</Label>
          <span className="text-xs text-muted-foreground">
            one per line · {fields.descriptors.length}/{L.descriptors}
          </span>
        </div>
        <Textarea
          id={`${id}-descriptors`}
          className="mt-2"
          rows={4}
          value={texts.descriptors}
          readOnly={readOnly}
          aria-describedby={`${id}-guidance ${id}-limits`}
          placeholder={"warm\nno-jargon\nsecond-person"}
          onChange={(event) => {
            const value = event.target.value;
            setTexts((current) => ({ ...current, descriptors: value }));
          }}
        />
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label htmlFor={`${id}-rules`}>Writing rules</Label>
          <span className="text-xs text-muted-foreground">
            one per line · {fields.writingRules.length}/{L.writingRules}
          </span>
        </div>
        <Textarea
          id={`${id}-rules`}
          className="mt-2"
          rows={4}
          value={texts.rules}
          readOnly={readOnly}
          aria-describedby={`${id}-guidance ${id}-limits`}
          placeholder={"Never use exclamation marks.\nAlways use serial commas."}
          onChange={(event) => {
            const value = event.target.value;
            setTexts((current) => ({ ...current, rules: value }));
          }}
        />
      </div>

      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label htmlFor={`${id}-snippets`}>Sample snippets</Label>
          <span className="text-xs text-muted-foreground">
            blank-line separated · {fields.sampleSnippets.length}/
            {L.sampleSnippets}
          </span>
        </div>
        <Textarea
          id={`${id}-snippets`}
          className="mt-2"
          rows={6}
          value={texts.snippets}
          readOnly={readOnly}
          aria-describedby={`${id}-guidance ${id}-limits`}
          placeholder="Paste a few approved examples of your real brand voice."
          onChange={(event) => {
            const value = event.target.value;
            setTexts((current) => ({ ...current, snippets: value }));
          }}
        />
      </div>

      <p id={`${id}-limits`} className="text-xs leading-5 text-muted-foreground">
        Per item: {L.descriptorBytes} bytes for descriptors, {L.ruleBytes} for
        rules, and {L.snippetBytes.toLocaleString()} for samples. Do not paste
        personal or confidential data; supported AI workflows send this profile
        to the configured model provider.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          loading={saving}
          disabled={!canEdit || !dirty || Boolean(validation)}
          aria-describedby={`${id}-guidance`}
        >
          Save profile
        </Button>
        <p
          id={`${id}-guidance`}
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          {guidance}
        </p>
      </div>
      {savedAt ? (
        <p className="text-xs text-muted-foreground">Updated {savedAt}</p>
      ) : null}
    </form>
  );
}
