/** Identity-scoped prompt shortcuts and verified shared prompt starters. */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  sensitiveLocalIdentityScope,
  type SanitizedLocalData,
} from "../../lib/sensitive-local-data";
import { useMe } from "../../lib/store";
import "../../styles-postwave-ai-context.css";
import { Notice } from "../Notice";
import {
  boundedDisplayText,
  inspectorFailureMessage,
} from "./contextual-inspector-helpers";

export interface SavedPrompt {
  id: string;
  name: string;
  prompt: string;
}

interface TemplateView {
  id: string;
  label: string;
  prompt: string | null;
}

interface Props {
  currentPrompt: string;
  onApply: (prompt: string) => void;
}

const LS_KEY = "postwave.ai.saved-prompts.v1";
const VAULT_NAMESPACE = "ai-prompts";
const MAX_SAVED_PROMPTS = 50;
const MAX_PROMPT_NAME_CHARACTERS = 120;
const MAX_PROMPT_CHARACTERS = 64_000;
const MAX_PROMPT_LIBRARY_BYTES = 400 * 1024;
const MAX_TEMPLATES = 100;

export function sanitizeSavedPrompts(
  candidate: unknown,
): SanitizedLocalData<SavedPrompt[]> | null {
  if (!Array.isArray(candidate)) return null;
  const valid: SavedPrompt[] = [];
  const ids = new Set<string>();
  let altered = false;
  for (const raw of candidate.slice(-MAX_SAVED_PROMPTS * 2)) {
    if (!raw || typeof raw !== "object") {
      altered = true;
      continue;
    }
    const value = raw as Partial<SavedPrompt>;
    if (
      typeof value.id !== "string" ||
      !value.id.trim() ||
      value.id.length > 200 ||
      ids.has(value.id) ||
      typeof value.name !== "string" ||
      !value.name.trim() ||
      value.name.length > MAX_PROMPT_NAME_CHARACTERS ||
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      value.prompt.length > MAX_PROMPT_CHARACTERS
    ) {
      altered = true;
      continue;
    }
    ids.add(value.id);
    valid.push({ id: value.id, name: value.name, prompt: value.prompt });
  }
  const bounded = valid.slice(-MAX_SAVED_PROMPTS);
  altered ||= bounded.length !== candidate.length;
  while (
    bounded.length > 0 &&
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
      MAX_PROMPT_LIBRARY_BYTES
  ) {
    bounded.shift();
    altered = true;
  }
  return { value: bounded, altered };
}

function templateArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as Record<string, unknown>;
  for (const key of ["templates", "items", "data"] as const) {
    if (Array.isArray(envelope[key])) return envelope[key] as unknown[];
  }
  return null;
}

function decodeTemplates(payload: unknown): TemplateView[] | null {
  const raw = templateArray(payload);
  if (!raw || raw.length > MAX_TEMPLATES) return null;
  const templates: TemplateView[] = [];
  const ids = new Set<string>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return null;
    const template = candidate as Record<string, unknown>;
    const id = boundedDisplayText(template["id"], 200);
    if (!id || ids.has(id)) return null;
    ids.add(id);
    const name =
      boundedDisplayText(template["name"], 200) ??
      boundedDisplayText(template["label"], 200);
    const slug = boundedDisplayText(template["slug"], 200);
    const description = boundedDisplayText(template["description"], 2000);
    const body = boundedDisplayText(template["body"], 4000);
    const label = name ?? slug ?? "Unnamed template";
    const prompt =
      name && description
        ? `Draft a ${name}. ${description}`
        : (name ?? description ?? body);
    templates.push({ id, label, prompt });
  }
  return templates;
}

function promptId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `p-${uuid}`
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function useSavedPromptStorage() {
  const me = useMe();
  const identityScope = sensitiveLocalIdentityScope(me?.user, me?.tenant);
  const scopeToken = identityScope ?? "unresolved";
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [retry, setRetry] = useState(0);
  const generationRef = useRef(0);
  const editRef = useRef(0);
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const generation = ++generationRef.current;
    const edit = ++editRef.current;
    setPrompts([]);
    setLoadedScope(null);
    setLoading(true);
    setError(null);
    setErrorRetryable(false);
    setDirty(false);
    void loadSensitiveLocalData({
      identityScope,
      namespace: VAULT_NAMESPACE,
      fallback: [] as SavedPrompt[],
      validate: sanitizeSavedPrompts,
      unownedLegacyKeys: [LS_KEY, "saved-prompts.v1"],
      unownedTenantLegacySuffixes: ["saved-prompts.v1"],
    }).then((loaded) => {
      if (generation !== generationRef.current) return;
      if (edit === editRef.current) setPrompts(loaded.value);
      setLoadedScope(scopeToken);
      setLoading(false);
      setError(loaded.warning);
      setErrorRetryable(loaded.retryable);
    });
    return () => {
      if (generation === generationRef.current) generationRef.current += 1;
    };
  }, [identityScope, retry, scopeToken]);

  const persist = useCallback(
    (candidate: SavedPrompt[]): boolean => {
      const sanitized = sanitizeSavedPrompts(candidate);
      if (!sanitized) {
        setError("The saved-prompt library is invalid or too large.");
        setErrorRetryable(false);
        return false;
      }
      if (sanitized.altered) {
        setError(
          "This change would exceed the encrypted saved-prompt library's 50-item or 400 KB limit. Remove an older or larger prompt first.",
        );
        setErrorRetryable(false);
        return false;
      }
      const generation = generationRef.current;
      const edit = ++editRef.current;
      setPrompts(sanitized.value);
      setLoading(false);
      setDirty(true);
      setError(null);
      setErrorRetryable(false);
      const write = writeQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const saved = await saveSensitiveLocalData({
            identityScope,
            namespace: VAULT_NAMESPACE,
            validate: sanitizeSavedPrompts,
            value: sanitized.value,
          });
          if (
            generation === generationRef.current &&
            edit === editRef.current
          ) {
            setPrompts(saved);
            setError(null);
            setErrorRetryable(false);
            setDirty(false);
          }
        });
      writeQueueRef.current = write;
      void write.catch(() => {
        if (generation === generationRef.current && edit === editRef.current) {
          setError(
            "Saved prompts changed for this session, but the encrypted desktop vault is unavailable. Keep this window open and retry to avoid losing them.",
          );
          setErrorRetryable(true);
        }
      });
      return true;
    },
    [identityScope],
  );

  const retryStorage = useCallback((): void => {
    if (dirty) persist(prompts);
    else setRetry((value) => value + 1);
  }, [dirty, persist, prompts]);

  const ownsRenderedScope = loadedScope === scopeToken;
  return {
    prompts: ownsRenderedScope ? prompts : [],
    loading: !ownsRenderedScope || loading,
    error: ownsRenderedScope ? error : null,
    errorRetryable: ownsRenderedScope && errorRetryable,
    identityScope,
    persist,
    retryStorage,
  };
}

function SavedPromptEntries({
  loading,
  prompts,
  onApply,
  onRemove,
}: {
  loading: boolean;
  prompts: SavedPrompt[];
  onApply: (prompt: string) => void;
  onRemove: (id: string) => void;
}): ReactElement {
  if (loading) {
    return (
      <div className="ai-context-loading" role="status" aria-live="polite">
        <span className="sr-only">Loading encrypted saved prompts…</span>
        <div className="skel" />
        <div className="skel" />
      </div>
    );
  }
  if (prompts.length === 0) {
    return (
      <p className="ai-context-empty">
        No personal prompts are saved for this user and workspace on this
        device.
      </p>
    );
  }
  return (
    <ul className="ai-prompt-list" aria-label="Encrypted personal prompts">
      {prompts.map((prompt) => (
        <li key={prompt.id} className="ai-prompt-row">
          <button
            type="button"
            className="ai-prompt-apply"
            onClick={() => onApply(prompt.prompt)}
          >
            <span className="ai-prompt-name">{prompt.name}</span>
            <span className="ai-prompt-preview">{prompt.prompt}</span>
          </button>
          <button
            type="button"
            className="ai-prompt-remove"
            onClick={() => onRemove(prompt.id)}
            aria-label={`Remove saved prompt ${prompt.name}`}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

function VoiceTemplateList({
  headingId,
  templates,
  loading,
  error,
  onRetry,
  onApply,
}: {
  headingId: string;
  templates: TemplateView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onApply: (prompt: string) => void;
}): ReactElement {
  let content: ReactElement;
  if (loading) {
    content = (
      <div className="ai-context-loading" role="status" aria-live="polite">
        <span className="sr-only">Loading shared prompt starters…</span>
        <div className="skel" />
      </div>
    );
  } else if (error) {
    content = (
      <Notice
        tone="danger"
        announcement="assertive"
        className="ai-context-notice"
        action={
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        }
      >
        {error}
      </Notice>
    );
  } else if (templates.length === 0) {
    content = (
      <p className="ai-context-empty">
        No voice templates are available. This workspace has no shared prompt
        starters.
      </p>
    );
  } else {
    content = (
      <ul className="ai-template-list">
        {templates.slice(0, 6).map((template) => (
          <li key={template.id}>
            <button
              type="button"
              className="ai-template-button"
              onClick={() => {
                if (template.prompt) onApply(template.prompt);
              }}
              aria-disabled={!template.prompt || undefined}
            >
              <span className="ai-template-name">{template.label}</span>
              <span className="ai-template-preview">
                {template.prompt ?? "Template content unavailable"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className="ai-context-section" aria-labelledby={headingId}>
      <div className="ai-context-section-heading">
        <h4 id={headingId} className="ai-context-label">
          Shared prompt starters
        </h4>
        <span className="ai-context-meta">Read from the voice service</span>
      </div>
      {content}
    </section>
  );
}

function SavedPromptsHeader({
  titleId,
  unavailableReason,
  availabilityId,
  onSave,
}: {
  titleId: string;
  unavailableReason: string | null;
  availabilityId: string;
  onSave: () => void;
}): ReactElement {
  return (
    <header className="ai-context-header ai-prompt-card-header">
      <div className="ai-context-header-copy">
        <span className="ai-context-kicker">Prompt library</span>
        <h3 id={titleId} className="ai-context-title">
          Saved prompts
        </h3>
      </div>
      <button
        type="button"
        className="btn btn-sm"
        onClick={onSave}
        aria-disabled={unavailableReason ? true : undefined}
        aria-describedby={unavailableReason ? availabilityId : undefined}
      >
        + Save
      </button>
    </header>
  );
}

export function SavedPromptsCard({
  currentPrompt,
  onApply,
}: Props): ReactElement {
  const {
    prompts,
    loading: storageLoading,
    error: storageError,
    errorRetryable: storageErrorRetryable,
    identityScope,
    persist: persistPrompts,
    retryStorage,
  } = useSavedPromptStorage();
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [templatesScope, setTemplatesScope] = useState<string | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [recentlyDeleted, setRecentlyDeleted] = useState<{
    prompt: SavedPrompt;
    index: number;
  } | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const saveAvailabilityId = useId();
  const nameAvailabilityId = useId();
  const cardTitleId = useId();
  const templatesTitleId = useId();
  const templateRequestRef = useRef(0);
  const templateBusyRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setRecentlyDeleted(null);
    setDraftName(null);
  }, [identityScope]);

  useEffect(() => {
    if (draftName !== null) nameInputRef.current?.focus();
  }, [draftName]);

  const loadTemplates = useCallback(async (): Promise<void> => {
    if (!identityScope) {
      setTemplates([]);
      setTemplatesScope("unresolved");
      setTemplatesError(null);
      setTemplatesLoading(false);
      return;
    }
    if (templateBusyRef.current) return;
    templateBusyRef.current = true;
    const request = ++templateRequestRef.current;
    const requestScope = identityScope;
    setTemplates([]);
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const result = await api.getVoiceTemplates();
      if (request !== templateRequestRef.current) return;
      if (result.error) {
        setTemplatesScope(requestScope);
        setTemplatesError(
          inspectorFailureMessage(result.error, "templates-load"),
        );
        return;
      }
      const decoded = decodeTemplates(result.data);
      if (!decoded) {
        setTemplatesScope(requestScope);
        setTemplatesError(
          inspectorFailureMessage({ kind: "parse" }, "templates-load"),
        );
        return;
      }
      setTemplates(decoded);
      setTemplatesScope(requestScope);
    } catch (caught) {
      if (request !== templateRequestRef.current) return;
      setTemplatesScope(requestScope);
      setTemplatesError(inspectorFailureMessage(caught, "templates-load"));
    } finally {
      if (request === templateRequestRef.current) {
        templateBusyRef.current = false;
        setTemplatesLoading(false);
      }
    }
  }, [identityScope]);

  useEffect(() => {
    void loadTemplates();
    return () => {
      templateRequestRef.current += 1;
      templateBusyRef.current = false;
    };
  }, [loadTemplates]);

  const trimmedPrompt = currentPrompt.trim();
  const saveUnavailableReason = storageLoading
    ? "Wait for encrypted saved prompts to finish loading."
    : !identityScope
      ? "Wait for the signed-in workspace identity before saving a prompt."
      : prompts.length >= MAX_SAVED_PROMPTS
        ? "The 50-prompt library is full. Remove a prompt before saving another."
        : !trimmedPrompt
          ? "Type a prompt in the chat composer before saving it."
          : trimmedPrompt.length > MAX_PROMPT_CHARACTERS
            ? "Keep saved prompts to 64,000 characters or fewer."
            : draftName !== null
              ? "Finish or cancel the prompt currently being named."
              : null;
  const nameUnavailableReason =
    draftName === null
      ? null
      : !draftName.trim()
        ? "Enter a name before saving this prompt."
        : !trimmedPrompt
          ? "The composer prompt is now empty. Cancel and start again."
          : trimmedPrompt.length > MAX_PROMPT_CHARACTERS
            ? "The composer prompt now exceeds 64,000 characters."
            : prompts.length >= MAX_SAVED_PROMPTS
              ? "The 50-prompt library is full."
              : null;

  function openNaming(): void {
    if (saveUnavailableReason) return;
    setDraftName(
      trimmedPrompt.slice(0, 40) + (trimmedPrompt.length > 40 ? "…" : ""),
    );
  }

  function save(): void {
    const name = (draftName ?? "").trim();
    if (nameUnavailableReason || !name || !identityScope) return;
    const accepted = persistPrompts([
      ...prompts,
      { id: promptId(), name, prompt: trimmedPrompt },
    ]);
    if (!accepted) return;
    setDraftName(null);
    setRecentlyDeleted(null);
  }

  function remove(id: string): void {
    const index = prompts.findIndex((prompt) => prompt.id === id);
    if (index < 0) return;
    const removed = prompts[index];
    if (!removed) return;
    if (!persistPrompts(prompts.filter((prompt) => prompt.id !== id))) return;
    setRecentlyDeleted({ prompt: removed, index });
  }

  function undoRemove(): void {
    if (!recentlyDeleted) return;
    if (prompts.some((prompt) => prompt.id === recentlyDeleted.prompt.id)) {
      setRecentlyDeleted(null);
      return;
    }
    const next = [...prompts];
    next.splice(
      Math.min(recentlyDeleted.index, next.length),
      0,
      recentlyDeleted.prompt,
    );
    if (persistPrompts(next)) setRecentlyDeleted(null);
  }

  const activeTemplateScope = identityScope ?? "unresolved";
  const ownsTemplateScope = templatesScope === activeTemplateScope;

  return (
    <section
      className="card ai-context-card"
      aria-labelledby={cardTitleId}
      aria-busy={storageLoading || !ownsTemplateScope || templatesLoading}
    >
      <SavedPromptsHeader
        titleId={cardTitleId}
        unavailableReason={saveUnavailableReason}
        availabilityId={saveAvailabilityId}
        onSave={openNaming}
      />
      <p className="ai-context-copy">
        Personal prompts are encrypted in the desktop vault and scoped to this
        signed-in user and workspace. Shared starters are fetched separately.
      </p>
      {saveUnavailableReason ? (
        <p id={saveAvailabilityId} className="ai-context-meta">
          {saveUnavailableReason}
        </p>
      ) : null}

      {draftName !== null && !storageLoading ? (
        <form
          className="ai-prompt-naming"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="ai-context-label" htmlFor={`${cardTitleId}-name`}>
            Prompt name
          </label>
          <input
            ref={nameInputRef}
            id={`${cardTitleId}-name`}
            className="ai-prompt-name-input"
            type="text"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            aria-label="Prompt name"
            maxLength={MAX_PROMPT_NAME_CHARACTERS}
            onKeyDown={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              ) {
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraftName(null);
              }
            }}
            aria-describedby={
              nameUnavailableReason ? nameAvailabilityId : undefined
            }
          />
          <div className="ai-prompt-naming-actions">
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              aria-disabled={nameUnavailableReason ? true : undefined}
              aria-describedby={
                nameUnavailableReason ? nameAvailabilityId : undefined
              }
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setDraftName(null)}
            >
              Cancel
            </button>
          </div>
          {nameUnavailableReason ? (
            <span
              id={nameAvailabilityId}
              className="ai-context-meta"
              role="status"
            >
              {nameUnavailableReason}
            </span>
          ) : null}
        </form>
      ) : null}

      {storageError ? (
        <Notice
          tone={storageErrorRetryable ? "danger" : "warning"}
          announcement={storageErrorRetryable ? "assertive" : "polite"}
          className="ai-context-notice"
          action={
            storageErrorRetryable ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={retryStorage}
              >
                Retry encrypted storage
              </button>
            ) : null
          }
        >
          {storageError}
        </Notice>
      ) : null}
      {!storageLoading && recentlyDeleted ? (
        <Notice
          tone="success"
          announcement="polite"
          className="ai-context-notice"
          action={
            <button type="button" className="btn btn-sm" onClick={undoRemove}>
              Undo
            </button>
          }
        >
          Removed “{recentlyDeleted.prompt.name}”.
        </Notice>
      ) : null}

      <SavedPromptEntries
        loading={storageLoading}
        prompts={prompts}
        onApply={onApply}
        onRemove={remove}
      />
      <VoiceTemplateList
        headingId={templatesTitleId}
        templates={ownsTemplateScope ? templates : []}
        loading={!ownsTemplateScope || templatesLoading}
        error={ownsTemplateScope ? templatesError : null}
        onRetry={() => void loadTemplates()}
        onApply={onApply}
      />
    </section>
  );
}
