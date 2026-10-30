// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Saved prompts for the Moosewave AI chat (desktop SavedPromptsCard.tsx).
//
// Personal prompts are device-local (lib/ai-chat-storage): scoped to this
// signed-in user and workspace, never sent to the server. Removing one is
// reversible through Undo until the next change. Shared starters are a
// separate read of GET /api/v1/voice/templates — the workspace's voice
// templates rendered as prompt openers.

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookmarkPlus, RefreshCw, Undo2 } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AI_CHAT_PROMPT_MAX_CHARS,
  listAiVoiceTemplateStarters,
} from "@/lib/ai-chat-api";
import {
  AI_MAX_PROMPT_NAME_CHARS,
  AI_MAX_SAVED_PROMPTS,
  newAiLocalId,
  readAiSavedPrompts,
  writeAiSavedPrompts,
  type AiChatStorageScope,
  type AiSavedPrompt,
} from "@/lib/ai-chat-storage";
import { apiErrorMessage } from "@/lib/api";
import { base, STALE, type RoleKey } from "@/lib/query-keys";

const STORAGE_REFUSED =
  "Saved prompts changed for this session, but this browser refused to store them. Retry before closing the page to keep them.";

export function SavedPromptsCard({
  scope,
  role,
  currentPrompt,
  onApply,
}: {
  scope: AiChatStorageScope;
  role: RoleKey;
  currentPrompt: string;
  onApply: (prompt: string) => void;
}) {
  const [prompts, setPrompts] = useState<AiSavedPrompt[]>(() =>
    readAiSavedPrompts(scope),
  );
  const [storageError, setStorageError] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [removed, setRemoved] = useState<{
    prompt: AiSavedPrompt;
    index: number;
  } | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const nameId = useId();
  const reasonId = useId();

  const starters = useQuery({
    queryKey: [
      ...base("voice-templates", scope.tenantId, role),
      "ai-chat-starters",
    ],
    queryFn: ({ signal }) => listAiVoiceTemplateStarters(signal),
    staleTime: STALE.list,
  });

  useEffect(() => {
    if (draftName !== null) nameInputRef.current?.focus();
  }, [draftName]);

  const persist = (next: AiSavedPrompt[]): void => {
    setPrompts(next);
    setStorageError(
      writeAiSavedPrompts(scope, next) ? null : STORAGE_REFUSED,
    );
  };

  const trimmed = currentPrompt.trim();
  const saveUnavailableReason =
    prompts.length >= AI_MAX_SAVED_PROMPTS
      ? `The ${AI_MAX_SAVED_PROMPTS}-prompt library is full. Remove a prompt before saving another.`
      : !trimmed
        ? "Type a prompt in the composer before saving it."
        : trimmed.length > AI_CHAT_PROMPT_MAX_CHARS
          ? `Keep saved prompts to ${AI_CHAT_PROMPT_MAX_CHARS.toLocaleString()} characters or fewer.`
          : null;

  const openNaming = (): void => {
    if (saveUnavailableReason) return;
    setDraftName(trimmed.slice(0, 40) + (trimmed.length > 40 ? "…" : ""));
  };

  const save = (): void => {
    const name = (draftName ?? "").trim();
    if (!name || saveUnavailableReason) return;
    persist([...prompts, { id: newAiLocalId("p"), name, prompt: trimmed }]);
    setDraftName(null);
    setRemoved(null);
  };

  const remove = (id: string): void => {
    const index = prompts.findIndex((prompt) => prompt.id === id);
    const prompt = prompts[index];
    if (!prompt) return;
    persist(prompts.filter((entry) => entry.id !== id));
    setRemoved({ prompt, index });
  };

  const undoRemove = (): void => {
    if (!removed) return;
    const next = [...prompts];
    if (!next.some((entry) => entry.id === removed.prompt.id)) {
      next.splice(Math.min(removed.index, next.length), 0, removed.prompt);
      persist(next);
    }
    setRemoved(null);
  };

  return (
    <Card aria-labelledby={titleId} className="min-w-0">
      <CardHeader className="gap-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle id={titleId} className="text-base">
            Saved prompts
          </CardTitle>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={openNaming}
            disabled={saveUnavailableReason !== null || draftName !== null}
            aria-describedby={saveUnavailableReason ? reasonId : undefined}
          >
            <BookmarkPlus aria-hidden />
            Save prompt
          </Button>
        </div>
        <CardDescription>
          Personal prompts stay in this browser for this user and workspace.
          Shared starters come from your workspace voice templates.
        </CardDescription>
        {saveUnavailableReason ? (
          <p id={reasonId} className="text-xs text-muted-foreground">
            {saveUnavailableReason}
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        {draftName !== null ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <Label htmlFor={nameId}>Prompt name</Label>
            <Input
              ref={nameInputRef}
              id={nameId}
              value={draftName}
              maxLength={AI_MAX_PROMPT_NAME_CHARS}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraftName(null);
                }
              }}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!draftName.trim()}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setDraftName(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        {storageError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription className="space-y-2">
              <p>{storageError}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => persist(prompts)}
              >
                <RefreshCw aria-hidden />
                Retry storage
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {removed ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="min-w-0 break-words">
              Removed “{removed.prompt.name}”.
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={undoRemove}>
              <Undo2 aria-hidden />
              Undo
            </Button>
          </div>
        ) : null}

        <section aria-label="Personal prompts" className="space-y-2">
          {prompts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No personal prompts are saved for this user and workspace in this
              browser.
            </p>
          ) : (
            <ul className="space-y-2">
              {prompts.map((prompt) => (
                <li
                  key={prompt.id}
                  className="flex min-w-0 items-start gap-2 rounded-md border p-2"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onApply(prompt.prompt)}
                    aria-label={`Apply saved prompt ${prompt.name}`}
                  >
                    <span className="block truncate text-sm font-medium">
                      {prompt.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {prompt.prompt}
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(prompt.id)}
                    aria-label={`Remove saved prompt ${prompt.name}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Shared prompt starters" className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Shared prompt starters
          </h4>
          {starters.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading shared prompt starters…
            </p>
          ) : starters.isError ? (
            <Alert variant="destructive">
              <AlertDescription className="space-y-2">
                <p>
                  {apiErrorMessage(
                    starters.error,
                    "Shared prompt starters could not be loaded.",
                  )}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void starters.refetch()}
                >
                  <RefreshCw aria-hidden />
                  Retry starters
                </Button>
              </AlertDescription>
            </Alert>
          ) : starters.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This workspace has no voice templates to offer as starters.
            </p>
          ) : (
            <ul className="space-y-2">
              {starters.data.slice(0, 6).map((starter) => (
                <li key={starter.id}>
                  <button
                    type="button"
                    className="w-full min-w-0 rounded-md border p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    disabled={!starter.prompt}
                    onClick={() => {
                      if (starter.prompt) onApply(starter.prompt);
                    }}
                    aria-label={`Apply starter ${starter.label}`}
                  >
                    <span className="block truncate text-sm font-medium">
                      {starter.label}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {starter.prompt ?? "Template content unavailable"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
