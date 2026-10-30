import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type UTMPreviewResponse,
  type UTMTemplate,
  utmTemplatesApi,
} from "../../lib/api-client";
import {
  type PersistentLifecycleOperation,
  usePersistentLifecycleOperation,
} from "../../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
} from "../../hooks/useSettingsDraftLifecycle";
import { toast } from "../Toast";
import {
  DEFAULT_UTM_PREVIEW_URL,
  EMPTY_UTM_FORM,
  formFromTemplate,
  type UTMFormState,
  type UTMParamKey,
  validateUTMForm,
  validateUTMPreviewUrl,
} from "./utm-template-helpers";

type MutationKind = "default" | "campaign" | "delete" | null;

interface UTMPreviewController {
  dirty: boolean;
  error: string | null;
  preview: UTMPreviewResponse | null;
  previewing: boolean;
  run: () => Promise<void>;
  setUrl: (value: string) => void;
  reset: () => void;
  url: string;
}

function useUTMPreviewController({
  campaignId,
  open,
  operation,
}: {
  campaignId: string | number;
  open: boolean;
  operation: PersistentLifecycleOperation;
}): UTMPreviewController {
  const [url, setUrlState] = useState(DEFAULT_UTM_PREVIEW_URL);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UTMPreviewResponse | null>(null);
  const activeRef = useRef(true);
  const openRef = useRef(open);
  const campaignRef = useRef(String(campaignId));
  const requestSequenceRef = useRef(0);
  const sessionSequenceRef = useRef(0);
  openRef.current = open;
  campaignRef.current = String(campaignId);

  const reset = useCallback((): void => {
    requestSequenceRef.current += 1;
    setUrlState(DEFAULT_UTM_PREVIEW_URL);
    setPreviewing(false);
    setError(null);
    setPreview(null);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestSequenceRef.current += 1;
      sessionSequenceRef.current += 1;
    };
  }, []);

  useEffect(() => {
    sessionSequenceRef.current += 1;
    reset();
  }, [campaignId, open, reset]);

  const setUrl = (value: string): void => {
    if (operation.promiseRef.current) return;
    requestSequenceRef.current += 1;
    setUrlState(value);
    setPreviewing(false);
    setError(null);
    setPreview(null);
  };

  const run = useCallback(async (): Promise<void> => {
    if (!openRef.current) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    const validation = validateUTMPreviewUrl(url);
    if (!validation.ok) {
      setPreview(null);
      setError(validation.error);
      return;
    }
    const requestId = ++requestSequenceRef.current;
    const sessionId = sessionSequenceRef.current;
    const requestCampaignId = campaignRef.current;
    setPreviewing(true);
    setError(null);
    setPreview(null);
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await utmTemplatesApi.preview({
          url: validation.url,
          campaign_id: requestCampaignId,
        });
        if (
          !activeRef.current ||
          !openRef.current ||
          requestId !== requestSequenceRef.current ||
          sessionId !== sessionSequenceRef.current
        ) {
          return;
        }
        if (result.error) {
          setError(result.error.message);
          return;
        }
        setPreview(result.data);
      } catch (previewError) {
        if (
          activeRef.current &&
          requestId === requestSequenceRef.current &&
          sessionId === sessionSequenceRef.current
        ) {
          setError(
            lifecycleOperationError(previewError, "The UTM preview failed."),
          );
        }
      } finally {
        if (
          activeRef.current &&
          requestId === requestSequenceRef.current &&
          sessionId === sessionSequenceRef.current
        ) {
          setPreviewing(false);
        }
      }
    });
    if (request) await request;
  }, [operation, url]);

  return {
    dirty: open && url !== DEFAULT_UTM_PREVIEW_URL,
    error,
    preview,
    previewing,
    reset,
    run,
    setUrl,
    url,
  };
}

interface UTMTemplateListController {
  error: string | null;
  load: () => Promise<void>;
  loading: boolean;
  templates: UTMTemplate[] | null;
}

function useUTMTemplateListController({
  campaignId,
  open,
}: {
  campaignId: string | number;
  open: boolean;
}): UTMTemplateListController {
  const [templates, setTemplates] = useState<UTMTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const activeRef = useRef(true);
  const openRef = useRef(open);
  const requestSequenceRef = useRef(0);
  const sessionSequenceRef = useRef(0);
  openRef.current = open;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestSequenceRef.current += 1;
      sessionSequenceRef.current += 1;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!activeRef.current || !openRef.current) return;
    const requestId = ++requestSequenceRef.current;
    const sessionId = sessionSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await utmTemplatesApi.list();
      if (
        !activeRef.current ||
        !openRef.current ||
        requestId !== requestSequenceRef.current ||
        sessionId !== sessionSequenceRef.current
      ) {
        return;
      }
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setTemplates(result.data.templates ?? []);
    } catch (loadError) {
      if (
        activeRef.current &&
        requestId === requestSequenceRef.current &&
        sessionId === sessionSequenceRef.current
      ) {
        setError(
          lifecycleOperationError(loadError, "Couldn't load UTM templates."),
        );
      }
    } finally {
      if (
        activeRef.current &&
        requestId === requestSequenceRef.current &&
        sessionId === sessionSequenceRef.current
      ) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    sessionSequenceRef.current += 1;
    requestSequenceRef.current += 1;
    setTemplates(null);
    setError(null);
    setLoading(false);
    if (open) void load();
  }, [campaignId, load, open]);

  return { error, load, loading, templates };
}

export interface UTMTemplatesController {
  applyToCampaign: () => Promise<void>;
  canEditTemplates: boolean;
  canMutate: boolean;
  closeDelete: () => void;
  deleteTarget: UTMTemplate | null;
  deleteTemplate: () => Promise<void>;
  discardConfirmOpen: boolean;
  discardDraft: () => void;
  form: UTMFormState;
  formHasValue: boolean;
  load: () => Promise<void>;
  loadError: string | null;
  loading: boolean;
  loadTemplate: (template: UTMTemplate) => void;
  mutation: MutationKind;
  operationActive: boolean;
  preview: UTMPreviewResponse | null;
  previewError: string | null;
  previewing: boolean;
  previewUrl: string;
  runPreview: () => Promise<void>;
  keepEditing: () => void;
  requestClose: () => boolean;
  saveDefault: () => Promise<void>;
  selectDelete: (template: UTMTemplate) => void;
  setFormValue: (key: UTMParamKey, value: string) => void;
  setPreviewUrl: (value: string) => void;
  templates: UTMTemplate[] | null;
  templatesGateTitle: string;
}

export function useUTMTemplatesController({
  campaignId,
  canAdmin,
  canMutate,
  open,
}: {
  campaignId: string | number;
  canAdmin: boolean;
  canMutate: boolean;
  open: boolean;
}): UTMTemplatesController {
  const canEditTemplates = canMutate && canAdmin;
  const [form, setForm] = useState<UTMFormState>(EMPTY_UTM_FORM);
  const [formBaseline, setFormBaseline] =
    useState<UTMFormState>(EMPTY_UTM_FORM);
  const [mutation, setMutation] = useState<MutationKind>(null);
  const [deleteTarget, setDeleteTarget] = useState<UTMTemplate | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const activeRef = useRef(true);
  const openRef = useRef(open);
  const canMutateRef = useRef(canMutate);
  const canEditRef = useRef(canEditTemplates);
  const campaignRef = useRef(String(campaignId));
  const sessionSequence = useRef(0);
  const mutationSequence = useRef(0);
  const listController = useUTMTemplateListController({ campaignId, open });
  const load = listController.load;
  const operation = usePersistentLifecycleOperation({
    ownerId: `utm-templates-${String(campaignId)}`,
    label: "UTM template request",
    detail:
      "Wait for the UTM template request to finish before leaving Moosewave.",
  });
  const previewController = useUTMPreviewController({
    campaignId,
    open,
    operation,
  });
  openRef.current = open;
  canMutateRef.current = canMutate;
  canEditRef.current = canEditTemplates;
  campaignRef.current = String(campaignId);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      sessionSequence.current += 1;
      mutationSequence.current += 1;
    };
  }, []);

  const formDirty = useMemo(
    () =>
      (Object.keys(form) as UTMParamKey[]).some(
        (key) => form[key] !== formBaseline[key],
      ),
    [form, formBaseline],
  );
  const draftDirty = open && (formDirty || previewController.dirty);
  const discardDraft = useCallback((): void => {
    setForm({ ...EMPTY_UTM_FORM });
    setFormBaseline({ ...EMPTY_UTM_FORM });
    previewController.reset();
    setDiscardConfirmOpen(false);
  }, [previewController]);
  useDiscardOnlyDraftLifecycle({
    ownerId: `utm-templates-${String(campaignId)}`,
    label: "UTM template draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "These UTM template fields or preview inputs have not been applied. Return to them or explicitly discard the draft.",
    operationDetail:
      "Wait for the UTM template request to finish before leaving Moosewave.",
    enabled: open,
  });

  const requestClose = useCallback((): boolean => {
    if (operation.promiseRef.current) return false;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return false;
    }
    discardDraft();
    return true;
  }, [discardDraft, draftDirty, operation.promiseRef]);

  useEffect(() => {
    sessionSequence.current += 1;
    mutationSequence.current += 1;
    setForm({ ...EMPTY_UTM_FORM });
    setFormBaseline({ ...EMPTY_UTM_FORM });
    setMutation(null);
    setDeleteTarget(null);
    setDiscardConfirmOpen(false);
  }, [campaignId, open]);

  useEffect(() => {
    if (canEditTemplates) return;
    mutationSequence.current += 1;
    if (!operation.promiseRef.current) setMutation(null);
    setDeleteTarget(null);
  }, [canEditTemplates, operation.promiseRef]);

  const formHasValue = useMemo(
    () => Object.values(form).some((value) => value.trim() !== ""),
    [form],
  );

  const save = useCallback(
    async (kind: "default" | "campaign"): Promise<void> => {
      if (!openRef.current) return;
      if (operation.promiseRef.current) {
        await operation.wait();
        return;
      }
      if (!canEditRef.current) {
        toast.error(
          canMutateRef.current
            ? "UTM template changes need an admin role"
            : "Viewer role can't save templates",
        );
        return;
      }
      const validation = validateUTMForm(form);
      if (!validation.ok) {
        toast.error(validation.error);
        return;
      }
      const requestId = ++mutationSequence.current;
      const sessionId = sessionSequence.current;
      const requestCampaignId = campaignRef.current;
      setMutation(kind);
      const request = operation.run(async (): Promise<void> => {
        try {
          const result =
            kind === "default"
              ? await utmTemplatesApi.upsertDefault(validation.input)
              : await utmTemplatesApi.upsertCampaign(
                  requestCampaignId,
                  validation.input,
                );
          if (
            !activeRef.current ||
            !openRef.current ||
            !canEditRef.current ||
            requestId !== mutationSequence.current ||
            sessionId !== sessionSequence.current
          ) {
            return;
          }
          if (result.error) {
            toast.error(
              kind === "default"
                ? `Couldn't save default template: ${result.error.message}`
                : `Couldn't apply to campaign: ${result.error.message}`,
            );
            return;
          }
          // Keep the just-used values available for the other explicit save
          // target, but acknowledge them as the local editor baseline so
          // lifecycle close does not misreport a completed request as dirty.
          setFormBaseline(form);
          toast.success(
            kind === "default"
              ? "Tenant default UTM template saved"
              : "UTM template applied to this campaign",
          );
          await load();
        } catch (error) {
          if (
            activeRef.current &&
            requestId === mutationSequence.current &&
            sessionId === sessionSequence.current
          ) {
            toast.error(
              `Couldn't ${kind === "default" ? "save default template" : "apply to campaign"}: ${lifecycleOperationError(
                error,
                "The UTM template request did not complete.",
              )}`,
            );
          }
        } finally {
          if (activeRef.current) setMutation(null);
        }
      });
      if (request) await request;
    },
    [form, load, operation],
  );

  const deleteTemplate = useCallback(async (): Promise<void> => {
    if (!openRef.current || !deleteTarget) return;
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    if (!canEditRef.current) {
      toast.error(
        canMutateRef.current
          ? "Deleting UTM templates needs an admin role"
          : "Viewer role can't delete templates",
      );
      return;
    }
    const requestId = ++mutationSequence.current;
    const sessionId = sessionSequence.current;
    const target = deleteTarget;
    setMutation("delete");
    const request = operation.run(async (): Promise<void> => {
      try {
        const result = await utmTemplatesApi.remove(target.id);
        if (
          !activeRef.current ||
          !openRef.current ||
          !canEditRef.current ||
          requestId !== mutationSequence.current ||
          sessionId !== sessionSequence.current
        ) {
          return;
        }
        if (result.error) {
          toast.error(`Couldn't delete template: ${result.error.message}`);
          return;
        }
        setDeleteTarget(null);
        toast.success("UTM template deleted");
        await load();
      } catch (error) {
        if (
          activeRef.current &&
          requestId === mutationSequence.current &&
          sessionId === sessionSequence.current
        ) {
          toast.error(
            `Couldn't delete template: ${lifecycleOperationError(
              error,
              "The UTM template request did not complete.",
            )}`,
          );
        }
      } finally {
        if (activeRef.current) setMutation(null);
      }
    });
    if (request) await request;
  }, [deleteTarget, load, operation]);

  return {
    applyToCampaign: () => save("campaign"),
    canEditTemplates,
    canMutate,
    closeDelete: () => {
      if (!operation.promiseRef.current) setDeleteTarget(null);
    },
    deleteTarget,
    deleteTemplate,
    discardConfirmOpen,
    discardDraft,
    form,
    formHasValue,
    keepEditing: () => setDiscardConfirmOpen(false),
    load,
    loadError: listController.error,
    loading: listController.loading,
    loadTemplate: (template) => {
      if (operation.promiseRef.current) return;
      const next = formFromTemplate(template);
      setForm(next);
      setFormBaseline(next);
    },
    mutation,
    operationActive: operation.active,
    preview: previewController.preview,
    previewError: previewController.error,
    previewing: previewController.previewing,
    previewUrl: previewController.url,
    requestClose,
    runPreview: previewController.run,
    saveDefault: () => save("default"),
    selectDelete: (template) => {
      if (canEditRef.current && !operation.promiseRef.current) {
        setDeleteTarget(template);
      }
    },
    setFormValue: (key, value) => {
      if (canMutateRef.current && !operation.promiseRef.current) {
        setForm((current) => ({ ...current, [key]: value }));
      }
    },
    setPreviewUrl: previewController.setUrl,
    templates: listController.templates,
    templatesGateTitle: !canMutate
      ? "Viewer role can't save templates"
      : "UTM template changes need an admin role",
  };
}
