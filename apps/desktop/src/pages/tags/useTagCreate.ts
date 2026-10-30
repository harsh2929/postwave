import { useEffect, useMemo, useRef, useState } from "react";

import { useFormErrors } from "../../components/FormField";
import { toast } from "../../components/Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import { type TagSuggestion, api } from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { isTagSuggestion } from "../../components/tags/tagRemoteValidation";
import { EMPTY_TAG_DRAFT, runeLength, type TagDraft } from "./tagPageModel";
import { tagIdentityKey } from "./tagCatalogContracts";

interface TagCreateDependencies {
  load: (options?: { forceFresh?: boolean }) => Promise<void>;
  reloadTaxonomy: () => Promise<void>;
}

export function useTagCreate({ load, reloadTaxonomy }: TagCreateDependencies) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const suggestionRequestRef = useRef(0);
  const formErrors = useFormErrors();

  const openCreate = (): void => {
    setDraft(EMPTY_TAG_DRAFT);
    setSubmitError(null);
    setSuggestions([]);
    setSuggestionError(null);
    formErrors.clear();
    setOpen(true);
  };

  useEffect(() => {
    const requestId = ++suggestionRequestRef.current;
    if (!open) return;
    const query = draft.name.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setSuggestionError(null);
      return;
    }
    setSuggestionError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await api.suggestTags(query, 5);
          if (requestId !== suggestionRequestRef.current) return;
          if (result.error) {
            setSuggestions([]);
            setSuggestionError(
              "Tag suggestions are unavailable. You can still create this tag.",
            );
            return;
          }
          const items = result.data?.items;
          if (
            result.data?.q !== query ||
            !Array.isArray(items) ||
            !items.every(isTagSuggestion)
          ) {
            setSuggestions([]);
            setSuggestionError(
              "Tag suggestions could not be verified. You can still create this tag.",
            );
            return;
          }
          setSuggestions(items);
        } catch {
          if (requestId !== suggestionRequestRef.current) return;
          setSuggestions([]);
          setSuggestionError(
            "Tag suggestions are unavailable. You can still create this tag.",
          );
        }
      })();
    }, 200);
    return () => {
      window.clearTimeout(timer);
      if (suggestionRequestRef.current === requestId) {
        suggestionRequestRef.current += 1;
      }
    };
  }, [draft.name, open]);

  const dedupHint = useMemo(() => {
    const query = tagIdentityKey(draft.name);
    if (!query) return null;
    return (
      suggestions.find(
        (suggestion) =>
          tagIdentityKey(suggestion.tag) === query &&
          (suggestion.subscribers > 0 || suggestion.registered),
      ) ?? null
    );
  }, [draft.name, suggestions]);

  const submit = async (): Promise<boolean> => {
    const name = draft.name.trim();
    formErrors.clear();
    if (!name) {
      formErrors.set("name", "Name is required.");
      return false;
    }
    if (runeLength(name) > 64) {
      formErrors.set("name", "Tag name must be 64 characters or fewer.");
      return false;
    }
    if (runeLength(draft.description) > 1_024) {
      formErrors.set("_form", "Description must be 1,024 characters or fewer.");
      return false;
    }
    setSubmitError(null);
    let result: Awaited<ReturnType<typeof api.createTag>>;
    try {
      result = await api.createTag({
        name,
        color: draft.color,
        description: draft.description,
        group_id: draft.groupId,
      });
    } catch (caught) {
      formErrors.set(
        "_form",
        lifecycleOperationError(caught, "The tag creation request failed."),
      );
      return false;
    }
    if (result.error) {
      formErrors.set("_form", result.error.message);
      return false;
    }
    setOpen(false);
    setDraft(EMPTY_TAG_DRAFT);
    setSuggestionError(null);
    if (result.queued) {
      toast.info({
        message: queueReceiptMessage(result.receipt),
        detail: `“${name}” will appear after the server confirms the create.`,
      });
      return true;
    }
    toast.success(`Tag "${name}" created`);
    void load({ forceFresh: true });
    void reloadTaxonomy();
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: "tag-create",
    label: "New tag draft",
    mode: "create",
    enabled: open,
    dirty: JSON.stringify(draft) !== JSON.stringify(EMPTY_TAG_DRAFT),
    save: submit,
    discard: () => {
      setDraft(EMPTY_TAG_DRAFT);
      setSubmitError(null);
      setSuggestions([]);
      setSuggestionError(null);
      formErrors.clear();
    },
    close: () => setOpen(false),
    detail:
      "This tag has not been created. Return to the form or explicitly discard it.",
    operationDetail:
      "Wait for the tag creation request to finish before leaving.",
    onError: (error) =>
      formErrors.set(
        "_form",
        lifecycleOperationError(error, "The tag couldn't be created."),
      ),
  });

  return {
    open,
    draft,
    setDraft,
    submitError,
    suggestions,
    suggestionError,
    dedupHint,
    formErrors,
    lifecycle,
    openCreate,
  };
}

export type TagCreateController = ReturnType<typeof useTagCreate>;
