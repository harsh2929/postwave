/**
 * FormDetailSlideover — slide-over for a single form. Tabs for embed code,
 * a mini-list of recent submissions, an inline settings editor, and a
 * danger-zone delete. Mirrors the `.slideover` shape used elsewhere.
 *
 * Talks to the Moosewave API via `api.getForm`, `api.updateForm`,
 * `api.deleteForm`, and `api.listFormSubmissions`. The submissions
 * endpoint is wired (apps/api/internal/forms/handlers.go's
 * ListSubmissions); the 404-tolerant fallback below stays in place so
 * a transient backend hiccup doesn't blank the panel.
 */

import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { ConfirmModal } from "./ConfirmModal";
import { ChoiceGroup } from "./ChoiceGroup";
import { EmbedPreviewCard } from "./forms/EmbedPreviewCard";
import {
  type FormField,
  FormFieldsEditor,
  firstFormFieldError,
} from "./forms/FormFieldsEditor";
import {
  type SpamSettings,
  FormSpamSettings,
  applySpamSettings,
  parseSpamSettings,
} from "./forms/FormSpamSettings";
import { SubmissionsAnalytics } from "./forms/SubmissionsAnalytics";
import { Notice } from "./Notice";
import { PendingSyncStatus } from "./PendingSyncStatus";
import {
  type FormDetail,
  type FormEmbedFlavor,
  type FormEmbedSnippetResponse,
  type FormOptInMode,
  type FormStatus,
  type FormSubmission,
  type FormUpdateInput,
  api,
} from "../lib/api-client";
import { useSlideoverBehavior } from "../hooks/useSlideoverBehavior";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { safeFormSuccessRedirectUrl } from "../lib/safe-url";
import { writeClipboardText } from "../lib/clipboard";
import { useCanAdmin, useCanWrite } from "../lib/store";
import { tauriApi } from "../lib/tauri";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { toast } from "./Toast";

type EmbedTab = "hosted" | "iframe" | "script" | "react";
type DetailTab = "overview" | "share" | "responses" | "settings";
type FieldWireMode = "canonical" | "legacy" | "unsupported";

const DETAIL_TABS = [
  { value: "overview", label: "Overview" },
  { value: "share", label: "Share" },
  { value: "responses", label: "Responses" },
  { value: "settings", label: "Settings" },
] as const satisfies ReadonlyArray<{ value: DetailTab; label: string }>;

const LEGACY_FIELD_TYPES = new Set([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "select",
  "checkbox",
  "textarea",
]);

interface CanonicalFormEmbed {
  flavor: FormEmbedFlavor;
  snippet: string;
  language: string;
  instructions: string;
  publicHost: string;
  publicUrl: string;
}

interface Props {
  formId: string;
  initial?: FormDetail | null;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}

function fmtDate(s: string | undefined | null): string {
  if (!s) return "—";
  try {
    const d = new Date(s);
    return Number.isNaN(d.getTime())
      ? s
      : d.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  } catch {
    return s;
  }
}

function statusBadge(status: FormStatus | string | undefined): ReactElement {
  const s = (status ?? "draft").toLowerCase();
  if (s === "published")
    return <span className="badge success">Published</span>;
  if (s === "archived") return <span className="badge warning">Archived</span>;
  return <span className="badge">Draft</span>;
}

function submissionBadge(s: string | undefined): ReactElement {
  const v = (s ?? "").toLowerCase();
  if (v === "confirmed")
    return <span className="badge success">Confirmed</span>;
  if (v === "unsubscribed") return <span className="badge warning">Unsub</span>;
  if (v === "pending") return <span className="badge accent">Pending</span>;
  return <span className="badge">{s ?? "—"}</span>;
}

function isLocalHttpUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return (
    url.protocol === "http:" &&
    (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]")
  );
}

function embedFlavorForTab(tab: EmbedTab): FormEmbedFlavor {
  return tab === "hosted" ? "iframe" : tab;
}

async function openHostedForm(url: string): Promise<void> {
  try {
    await tauriApi.openUrl(url);
  } catch (err) {
    toast.error(
      err instanceof Error ? err.message : "Could not open hosted form",
    );
  }
}

function canonicalEmbedFromResponse(
  response: FormEmbedSnippetResponse,
  expectedFlavor: FormEmbedFlavor,
): CanonicalFormEmbed | null {
  if (
    response?.flavor !== expectedFlavor ||
    typeof response.snippet !== "string" ||
    response.snippet.trim() === "" ||
    typeof response.language !== "string" ||
    typeof response.instructions !== "string" ||
    typeof response.public_host !== "string" ||
    typeof response.public_url !== "string"
  ) {
    return null;
  }
  try {
    const publicHost = new URL(response.public_host);
    const publicUrl = new URL(response.public_url);
    const safeProtocol = (url: URL): boolean =>
      url.protocol === "https:" || isLocalHttpUrl(url);
    if (
      !safeProtocol(publicHost) ||
      !safeProtocol(publicUrl) ||
      publicHost.username ||
      publicHost.password ||
      publicUrl.username ||
      publicUrl.password ||
      publicHost.origin !== publicUrl.origin
    ) {
      return null;
    }
    const canonicalHost = publicHost.toString().replace(/\/$/, "");
    if (!publicUrl.toString().startsWith(`${canonicalHost}/forms/`)) {
      return null;
    }
    return {
      flavor: response.flavor,
      snippet: response.snippet,
      language: response.language,
      instructions: response.instructions,
      publicHost: canonicalHost,
      publicUrl: publicUrl.toString(),
    };
  } catch {
    return null;
  }
}

function useCanonicalFormEmbed(
  formId: string,
  tab: EmbedTab,
  canAdmin: boolean,
): {
  embed: CanonicalFormEmbed | null;
  embedErr: string | null;
  embedLoading: boolean;
  embedText: string;
  retryEmbed: () => void;
} {
  const [embed, setEmbed] = useState<CanonicalFormEmbed | null>(null);
  const [embedLoading, setEmbedLoading] = useState(true);
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [embedRevision, setEmbedRevision] = useState(0);
  const embedFlavor = embedFlavorForTab(tab);

  useEffect(() => {
    if (!canAdmin) {
      setEmbed(null);
      setEmbedLoading(false);
      setEmbedErr(
        "Admin access is required to retrieve canonical share and embed details.",
      );
      return;
    }
    const abortController = new AbortController();
    setEmbed(null);
    setEmbedLoading(true);
    setEmbedErr(null);
    void (async () => {
      try {
        const res = await api.getFormEmbed(formId, embedFlavor, {
          signal: abortController.signal,
        });
        if (abortController.signal.aborted) return;
        if (res.error) {
          setEmbedErr(res.error.message);
          return;
        }
        const canonical = canonicalEmbedFromResponse(res.data, embedFlavor);
        setEmbed(canonical);
        if (!canonical) {
          setEmbedErr(
            "The server did not return a valid canonical share contract.",
          );
        }
      } catch (requestError) {
        if (abortController.signal.aborted) return;
        setEmbedErr(
          requestError instanceof Error
            ? requestError.message
            : "Could not retrieve canonical share details.",
        );
      } finally {
        if (!abortController.signal.aborted) setEmbedLoading(false);
      }
    })();
    return () => abortController.abort();
  }, [canAdmin, embedFlavor, embedRevision, formId]);

  return {
    embed,
    embedErr,
    embedLoading,
    embedText: embed
      ? tab === "hosted"
        ? embed.publicUrl
        : embed.snippet
      : "",
    retryEmbed: () => setEmbedRevision((revision) => revision + 1),
  };
}

/**
 * Read the fields array out of a form, tolerant of both shapes:
 *  - structure.fields  (single-step legacy)
 *  - steps[0].fields   (multi-step X3)
 * Returns [] when neither is present.
 */
function readInitialFields(form: FormDetail | null | undefined): FormField[] {
  if (!form) return [];
  const structureFields = form.structure?.["fields"];
  if (Array.isArray(structureFields)) {
    return (structureFields as FormField[]).filter(
      (f) => f && typeof f.key === "string",
    );
  }
  return [];
}

/**
 * True when the form's `structure.fields` uses the canonical
 * `{id, kind, …}` schema (what the backend creates by default and what
 * the hosted renderer consumes) rather than the desktop editor's legacy
 * `{key, type}` shape. The desktop editor can't safely round-trip the
 * canonical schema (it would drop structural kinds like heading/submit/
 * honeypot and rename inputs), so we must NOT let it overwrite such a
 * structure — doing so silently wiped the live public form (P0 D08#1).
 */
function formFieldWireMode(form: FormDetail | null | undefined): FieldWireMode {
  const structureFields = form?.structure?.["fields"];
  if (structureFields === undefined) return "legacy";
  if (!Array.isArray(structureFields)) return "unsupported";
  if (structureFields.length === 0) return "legacy";

  const records = structureFields.filter(
    (field): field is Record<string, unknown> =>
      Boolean(field) && typeof field === "object" && !Array.isArray(field),
  );
  if (records.length !== structureFields.length) return "unsupported";

  const canonical = records.every(
    (field) =>
      typeof field["key"] !== "string" &&
      typeof field["kind"] === "string" &&
      typeof field["id"] === "string",
  );
  if (canonical) return "canonical";

  const legacy = records.every((field) => {
    const options = field["options"];
    return (
      typeof field["key"] === "string" &&
      typeof field["label"] === "string" &&
      typeof field["type"] === "string" &&
      LEGACY_FIELD_TYPES.has(field["type"]) &&
      (field["required"] === undefined ||
        typeof field["required"] === "boolean") &&
      (options === undefined ||
        (Array.isArray(options) &&
          options.every((option) => typeof option === "string")))
    );
  });
  if (legacy) return "legacy";

  return "unsupported";
}

function fieldWireModeNotice(mode: FieldWireMode): string {
  if (mode === "canonical") {
    return "This form uses the canonical builder schema, which the desktop field editor cannot safely round-trip.";
  }
  return "This form uses an unrecognised or mixed field schema. Field editing is locked so the desktop app cannot damage the live form.";
}

/** Human-readable labels of the canonical fields, for the read-only notice. */
function canonicalFieldLabels(form: FormDetail | null | undefined): string[] {
  const structureFields = form?.structure?.["fields"];
  if (!Array.isArray(structureFields)) return [];
  return (structureFields as Array<Record<string, unknown>>)
    .filter((f) => f && f["kind"] !== "honeypot" && f["kind"] !== "submit")
    .map((f) => {
      const label = typeof f["label"] === "string" ? f["label"] : "";
      const kind = typeof f["kind"] === "string" ? f["kind"] : "field";
      return label ? `${label} (${kind})` : String(kind);
    });
}

interface FormSettingsDraft {
  fieldWireMode: FieldWireMode;
  fields: FormField[];
  fieldsDirty: boolean;
  name: string;
  optInMode: FormOptInMode;
  redirectUrl: string;
  spam: SpamSettings;
  successMessage: string;
}

function draftFromForm(form: FormDetail | null | undefined): FormSettingsDraft {
  return {
    fieldWireMode: formFieldWireMode(form),
    fields: readInitialFields(form),
    fieldsDirty: false,
    name: form?.name ?? "",
    optInMode: form?.optInMode ?? "double",
    redirectUrl: String(form?.settings?.["successRedirectUrl"] ?? ""),
    spam: parseSpamSettings(form?.settings),
    successMessage: String(form?.settings?.["successMessage"] ?? ""),
  };
}

function formSettingsDirty(
  form: FormDetail | null,
  draft: FormSettingsDraft,
): boolean {
  return Boolean(
    form &&
    (draft.name !== form.name ||
      draft.optInMode !== form.optInMode ||
      draft.successMessage !==
        String(form.settings?.["successMessage"] ?? "") ||
      draft.redirectUrl !==
        String(form.settings?.["successRedirectUrl"] ?? "") ||
      JSON.stringify(draft.spam) !==
        JSON.stringify(parseSpamSettings(form.settings)) ||
      draft.fieldsDirty),
  );
}

function buildSettingsPatch(
  form: FormDetail,
  draft: FormSettingsDraft,
): { error: string } | { patch: FormUpdateInput } {
  const safeRedirectUrl = safeFormSuccessRedirectUrl(draft.redirectUrl);
  if (safeRedirectUrl === null) {
    return {
      error: "Redirect URL must be HTTPS, localhost HTTP, or root-relative.",
    };
  }
  if (draft.fieldsDirty && draft.fieldWireMode !== "legacy") {
    return {
      error:
        "Field changes were blocked because this field schema cannot be safely round-tripped by the desktop app.",
    };
  }
  const fieldError = draft.fieldsDirty
    ? firstFormFieldError(draft.fields)
    : null;
  if (fieldError) {
    return {
      error: `Field ${fieldError.index + 1}: ${fieldError.message}`,
    };
  }

  let settings: Record<string, unknown> = {
    ...(form.settings ?? {}),
    successMessage: draft.successMessage,
  };
  if (safeRedirectUrl) settings["successRedirectUrl"] = safeRedirectUrl;
  else delete settings["successRedirectUrl"];
  settings = applySpamSettings(settings, draft.spam);

  const patch: FormUpdateInput = {
    name: draft.name.trim() || form.name,
    optInMode: draft.optInMode,
    settings,
  };
  if (draft.fieldsDirty) {
    patch.structure = { ...(form.structure ?? {}), fields: draft.fields };
  }
  return { patch };
}

function validFormDetailFor(
  value: unknown,
  formId: string,
): value is FormDetail {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FormDetail>;
  return (
    candidate.id === formId &&
    typeof candidate.name === "string" &&
    typeof candidate.slug === "string" &&
    (candidate.optInMode === "single" || candidate.optInMode === "double") &&
    (candidate.status === "draft" ||
      candidate.status === "published" ||
      candidate.status === "archived")
  );
}

function strongFormVersion(value: string | undefined): string | null {
  if (!value || value !== value.trim() || value.startsWith("W/")) return null;
  return /^"[^"\r\n]+"$/.test(value) ? value : null;
}

function useFormDetailRemoteData(
  formId: string,
  initial: FormDetail | null | undefined,
  canAdmin: boolean,
) {
  const [form, setForm] = useState<FormDetail | null>(
    initial?.id === formId ? initial : null,
  );
  const [loading, setLoading] = useState(!initial);
  const [err, setErr] = useState<string | null>(null);
  const [subs, setSubs] = useState<FormSubmission[] | null>(null);
  const [subsErr, setSubsErr] = useState<string | null>(null);
  const [subsLoading, setSubsLoading] = useState(canAdmin);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setErr(null);
      setServerVersion(null);
      try {
        const res = await api.getForm(formId);
        if (cancelled) return;
        if (res.error) setErr(res.error.message);
        else if (!validFormDetailFor(res.data, formId)) {
          setErr("The server returned an invalid form detail contract.");
        } else {
          setForm(res.data);
          const nextVersion = strongFormVersion(res.serverVersion);
          setServerVersion(nextVersion);
          if (!nextVersion) {
            setErr(
              "The form loaded without a confirmed server revision. Editing is locked to prevent overwriting a newer version.",
            );
          }
        }
      } catch (requestError) {
        if (!cancelled) {
          setErr(
            requestError instanceof Error
              ? requestError.message
              : "Could not load this form.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [formId, reloadRevision]);

  useEffect(() => {
    if (!canAdmin) {
      setSubs(null);
      setSubsErr(null);
      setSubsLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setSubs(null);
      setSubsLoading(true);
      setSubsErr(null);
      try {
        const res = await api.listFormSubmissions(formId);
        if (cancelled) return;
        if (res.error) {
          setSubs(null);
          if (!res.error.status || res.error.status !== 404) {
            setSubsErr(res.error.message);
          }
        } else if (!Array.isArray(res.data)) {
          setSubs(null);
          setSubsErr("The server returned an invalid submissions contract.");
        } else setSubs(res.data);
      } catch (requestError) {
        if (!cancelled) {
          setSubs(null);
          setSubsErr(
            requestError instanceof Error
              ? requestError.message
              : "Could not load submissions.",
          );
        }
      } finally {
        if (!cancelled) setSubsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canAdmin, formId]);

  return {
    err,
    form: form?.id === formId ? form : null,
    loading,
    reload: () => setReloadRevision((revision) => revision + 1),
    serverVersion,
    setServerVersion,
    setForm,
    subs,
    subsErr,
    subsLoading,
  };
}

interface FormDetailOperationOptions {
  canDelete: boolean;
  canMutate: boolean;
  draft: FormSettingsDraft;
  form: FormDetail | null;
  formId: string;
  onChanged: () => void;
  onDeleted: () => void;
  serverVersion: string | null;
  setDraft: Dispatch<SetStateAction<FormSettingsDraft>>;
  setForm: Dispatch<SetStateAction<FormDetail | null>>;
  setServerVersion: Dispatch<SetStateAction<string | null>>;
  settingsDirty: boolean;
}

interface FormDeleteOperationOptions {
  canDelete: boolean;
  form: FormDetail | null;
  formId: string;
  onDeleted: () => void;
  serverVersion: string | null;
  setConcurrencyConflict: Dispatch<SetStateAction<string | null>>;
  setServerVersion: Dispatch<SetStateAction<string | null>>;
}

function useFormDeleteOperation({
  canDelete,
  form,
  formId,
  onDeleted,
  serverVersion,
  setConcurrencyConflict,
  setServerVersion,
}: FormDeleteOperationOptions) {
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const mountedRef = useRef(false);
  const currentFormIdRef = useRef(formId);
  const canDeleteRef = useRef(canDelete);
  const flightRef = useRef<symbol | null>(null);
  currentFormIdRef.current = formId;
  canDeleteRef.current = canDelete;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flightRef.current = null;
    };
  }, []);

  useEffect(() => {
    flightRef.current = null;
    setDeleteConfirmOpen(false);
    setDeleting(false);
  }, [formId]);

  const requestIsCurrent = useCallback(
    (expectedFormId: string): boolean =>
      mountedRef.current &&
      currentFormIdRef.current === expectedFormId &&
      canDeleteRef.current,
    [],
  );

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!canDelete || !form || form.id !== formId || flightRef.current) return;
    if (!serverVersion) {
      toast.error(
        "Reload this form before deleting; no confirmed server revision is available.",
      );
      return;
    }
    const expectedFormId = form.id;
    const flight = Symbol("delete-form");
    flightRef.current = flight;
    setDeleting(true);
    try {
      const res = await api.deleteForm(expectedFormId, {
        expectedVersion: serverVersion,
      });
      if (!requestIsCurrent(expectedFormId) || flightRef.current !== flight) {
        return;
      }
      if (res.error) {
        if (res.error.status === 412) {
          setDeleteConfirmOpen(false);
          setServerVersion(null);
          setConcurrencyConflict(
            "This form changed elsewhere after you loaded it. Reload the current version before deleting it.",
          );
          toast.error("Form changed elsewhere. Reload before deleting.");
          return;
        }
        toast.error(res.error.message);
        return;
      }
      if (res.data?.ok !== true) {
        toast.error("The server did not confirm that the form was deleted.");
        return;
      }
      setDeleteConfirmOpen(false);
      toast.success("Form deleted");
      onDeleted();
    } catch (requestError) {
      if (requestIsCurrent(expectedFormId) && flightRef.current === flight) {
        toast.error(
          requestError instanceof Error
            ? requestError.message
            : "Could not delete this form.",
        );
      }
    } finally {
      if (flightRef.current === flight) {
        flightRef.current = null;
        if (mountedRef.current && currentFormIdRef.current === expectedFormId) {
          setDeleting(false);
        }
      }
    }
  }, [
    canDelete,
    form,
    formId,
    onDeleted,
    requestIsCurrent,
    serverVersion,
    setConcurrencyConflict,
    setServerVersion,
  ]);

  return {
    confirmDelete,
    deleteConfirmOpen,
    deleting,
    doDelete: () => {
      if (canDelete && form?.id === formId && !deleting && serverVersion) {
        setDeleteConfirmOpen(true);
      }
    },
    setDeleteConfirmOpen,
  };
}

function useFormDetailOperations({
  canDelete,
  canMutate,
  draft,
  form,
  formId,
  onChanged,
  onDeleted,
  serverVersion,
  setDraft,
  setForm,
  setServerVersion,
  settingsDirty,
}: FormDetailOperationOptions) {
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingPublish, setSavingPublish] = useState(false);
  const [concurrencyConflict, setConcurrencyConflict] = useState<string | null>(
    null,
  );
  const mountedRef = useRef(false);
  const currentFormIdRef = useRef(formId);
  const canMutateRef = useRef(canMutate);
  const saveFlightRef = useRef<symbol | null>(null);
  const publishFlightRef = useRef<symbol | null>(null);
  currentFormIdRef.current = formId;
  canMutateRef.current = canMutate;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      saveFlightRef.current = null;
      publishFlightRef.current = null;
    };
  }, []);

  useEffect(() => {
    saveFlightRef.current = null;
    publishFlightRef.current = null;
    setSavingSettings(false);
    setSavingPublish(false);
    setConcurrencyConflict(null);
  }, [formId]);

  const requestIsCurrent = useCallback(
    (expectedFormId: string): boolean =>
      mountedRef.current &&
      currentFormIdRef.current === expectedFormId &&
      canMutateRef.current,
    [],
  );
  const clearConcurrencyConflict = useCallback(
    () => setConcurrencyConflict(null),
    [],
  );
  const deletion = useFormDeleteOperation({
    canDelete,
    form,
    formId,
    onDeleted,
    serverVersion,
    setConcurrencyConflict,
    setServerVersion,
  });

  const saveSettings = useCallback(async (): Promise<void> => {
    if (!canMutate || !form || form.id !== formId || saveFlightRef.current) {
      return;
    }
    if (!serverVersion) {
      toast.error(
        "Reload this form before saving; no confirmed server revision is available.",
      );
      return;
    }
    const built = buildSettingsPatch(form, draft);
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    const expectedFormId = form.id;
    const expectedVersion = serverVersion;
    const flight = Symbol("save-form-settings");
    saveFlightRef.current = flight;
    setSavingSettings(true);
    try {
      const res = await api.updateForm(expectedFormId, built.patch, {
        expectedVersion,
        requireOnline: true,
      });
      if (
        !requestIsCurrent(expectedFormId) ||
        saveFlightRef.current !== flight
      ) {
        return;
      }
      if (res.error) {
        if (res.error.status === 412) {
          setServerVersion(null);
          setConcurrencyConflict(
            "This form changed elsewhere after you loaded it. Your local draft is preserved; reload the current version before saving again.",
          );
          toast.error("Form changed elsewhere. Reload before saving again.");
          return;
        }
        toast.error(res.error.message);
        return;
      }
      if (res.queued) {
        setServerVersion(null);
        setConcurrencyConflict(
          "The update was not confirmed by the server. Reload before making another change.",
        );
        toast.error(
          "Form edits require an online concurrency check and were not applied locally.",
        );
        return;
      }
      if (!validFormDetailFor(res.data, expectedFormId)) {
        setServerVersion(null);
        setConcurrencyConflict(
          "The server accepted the update but returned an invalid form contract. Reload before editing again.",
        );
        toast.error("The server returned an invalid saved form contract.");
        return;
      }
      setForm(res.data);
      setDraft(draftFromForm(res.data));
      const nextVersion = strongFormVersion(res.serverVersion);
      setServerVersion(nextVersion);
      setConcurrencyConflict(
        nextVersion
          ? null
          : "The form was saved, but the server omitted its next revision. Reload before editing again.",
      );
      if (nextVersion) toast.success("Saved");
      else toast.error("Saved, but reload is required before another edit.");
      onChanged();
    } catch (requestError) {
      if (
        requestIsCurrent(expectedFormId) &&
        saveFlightRef.current === flight
      ) {
        toast.error(
          requestError instanceof Error
            ? requestError.message
            : "Could not save form settings.",
        );
      }
    } finally {
      if (saveFlightRef.current === flight) {
        saveFlightRef.current = null;
        if (mountedRef.current && currentFormIdRef.current === expectedFormId) {
          setSavingSettings(false);
        }
      }
    }
  }, [
    canMutate,
    draft,
    form,
    formId,
    onChanged,
    requestIsCurrent,
    serverVersion,
    setDraft,
    setForm,
    setServerVersion,
  ]);

  const togglePublished = useCallback(async (): Promise<void> => {
    if (!canMutate || !form || form.id !== formId || publishFlightRef.current) {
      return;
    }
    if (!serverVersion) {
      toast.error(
        "Reload this form before changing publication; no confirmed server revision is available.",
      );
      return;
    }
    if (settingsDirty) {
      toast.error("Save or discard settings changes before publishing.");
      return;
    }
    const expectedFormId = form.id;
    const expectedVersion = serverVersion;
    const next: FormStatus =
      form.status === "published" ? "draft" : "published";
    const flight = Symbol("publish-form");
    publishFlightRef.current = flight;
    setSavingPublish(true);
    try {
      const res = await api.updateForm(
        expectedFormId,
        { status: next },
        { expectedVersion, requireOnline: true },
      );
      if (
        !requestIsCurrent(expectedFormId) ||
        publishFlightRef.current !== flight
      ) {
        return;
      }
      if (res.error) {
        if (res.error.status === 412) {
          setServerVersion(null);
          setConcurrencyConflict(
            "This form changed elsewhere after you loaded it. Reload the current version before changing publication.",
          );
          toast.error("Form changed elsewhere. Reload before publishing.");
          return;
        }
        toast.error(res.error.message);
        return;
      }
      if (res.queued) {
        setServerVersion(null);
        setConcurrencyConflict(
          "The publication change was not confirmed online. Reload before trying again.",
        );
        toast.error("Publication changes cannot be queued offline.");
        return;
      }
      if (!validFormDetailFor(res.data, expectedFormId)) {
        setServerVersion(null);
        setConcurrencyConflict(
          "The server returned an invalid form after changing publication. Reload before editing again.",
        );
        toast.error("The server returned an invalid publication contract.");
        return;
      }
      setForm(res.data);
      setDraft(draftFromForm(res.data));
      const nextVersion = strongFormVersion(res.serverVersion);
      setServerVersion(nextVersion);
      setConcurrencyConflict(
        nextVersion
          ? null
          : "Publication changed, but the server omitted its next revision. Reload before editing again.",
      );
      if (nextVersion) {
        toast.success(
          next === "published" ? "Form published" : "Moved to draft",
        );
      } else toast.error("Publication changed; reload before another edit.");
      onChanged();
    } catch (requestError) {
      if (
        requestIsCurrent(expectedFormId) &&
        publishFlightRef.current === flight
      ) {
        toast.error(
          requestError instanceof Error
            ? requestError.message
            : "Could not change form publication.",
        );
      }
    } finally {
      if (publishFlightRef.current === flight) {
        publishFlightRef.current = null;
        if (mountedRef.current && currentFormIdRef.current === expectedFormId) {
          setSavingPublish(false);
        }
      }
    }
  }, [
    canMutate,
    form,
    formId,
    onChanged,
    requestIsCurrent,
    serverVersion,
    setDraft,
    setForm,
    setServerVersion,
    settingsDirty,
  ]);

  return {
    clearConcurrencyConflict,
    concurrencyConflict,
    ...deletion,
    saveSettings,
    savingPublish,
    savingSettings,
    togglePublished,
  };
}

function useFormDetailController({
  formId,
  initial,
  onClose,
  onChanged,
  onDeleted,
}: Props) {
  const canMutate = useCanWrite();
  const canAdmin = useCanAdmin();
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [embedTab, setEmbedTab] = useState<EmbedTab>("iframe");
  const [draft, setDraft] = useState<FormSettingsDraft>(() =>
    draftFromForm(initial),
  );
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const data = useFormDetailRemoteData(formId, initial, canAdmin);
  const { embed, embedErr, embedLoading, embedText, retryEmbed } =
    useCanonicalFormEmbed(formId, embedTab, canAdmin);

  useEffect(() => {
    if (data.form) setDraft(draftFromForm(data.form));
  }, [data.form]);

  const settingsDirty = formSettingsDirty(data.form, draft);
  const operations = useFormDetailOperations({
    canDelete: canAdmin,
    canMutate,
    draft,
    form: data.form,
    formId,
    onChanged,
    onDeleted,
    serverVersion: data.serverVersion,
    setDraft,
    setForm: data.setForm,
    setServerVersion: data.setServerVersion,
    settingsDirty,
  });
  const restoreDraft = useCallback(() => {
    setDraft(draftFromForm(data.form));
  }, [data.form]);
  const closeLocked =
    operations.savingSettings ||
    operations.savingPublish ||
    operations.deleting;
  const revisionUnavailableReason =
    operations.concurrencyConflict ??
    (data.loading
      ? "Confirming the current server revision before changes are enabled."
      : !data.serverVersion
        ? "Changes are locked because the server did not confirm a current form revision. Reload to reconcile before changing this form."
        : null);
  const mutationUnavailableReason = canMutate
    ? revisionUnavailableReason
    : null;
  const deleteUnavailableReason = canAdmin ? revisionUnavailableReason : null;
  const requestConflictReload = useCallback(() => {
    if (settingsDirty) {
      setReloadConfirmOpen(true);
      return;
    }
    operations.clearConcurrencyConflict();
    data.reload();
  }, [data, operations, settingsDirty]);
  const confirmConflictReload = useCallback(() => {
    restoreDraft();
    operations.clearConcurrencyConflict();
    setReloadConfirmOpen(false);
    data.reload();
  }, [data, operations, restoreDraft]);
  const requestClose = useCallback(() => {
    if (closeLocked) return;
    if (settingsDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [closeLocked, onClose, settingsDirty]);

  useSlideoverBehavior({
    open: true,
    onClose: requestClose,
    disableEscape: closeLocked,
  });

  useEffect(() => {
    const operationActive =
      operations.savingSettings ||
      operations.savingPublish ||
      operations.deleting;
    if (!settingsDirty && !operationActive) return;
    return registerLifecycleGuard({
      id: `form-detail-${formId}`,
      label: "Form settings changes",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : operationActive
            ? {
                level: "blocking",
                detail:
                  "The form is still saving, publishing, or being deleted.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "The form has settings or field changes not yet saved.",
              },
      prepare:
        operationActive || mutationUnavailableReason
          ? undefined
          : operations.saveSettings,
      discard: () => {
        restoreDraft();
        onClose();
      },
    });
  }, [
    formId,
    onClose,
    operations.deleting,
    operations.saveSettings,
    operations.savingPublish,
    operations.savingSettings,
    mutationUnavailableReason,
    restoreDraft,
    settingsDirty,
  ]);

  const copy = useCallback(
    async (text: string, label: string): Promise<void> => {
      try {
        const result = await writeClipboardText(text, {
          contentClass: "public",
          label,
        });
        if (result.ok) toast.success(`${label} copied`);
        else toast.error(result.message);
      } catch (copyError) {
        toast.error(
          copyError instanceof Error
            ? copyError.message
            : `${label} copy failed`,
        );
      }
    },
    [],
  );

  return {
    actions: {
      confirmDelete: operations.confirmDelete,
      confirmConflictReload,
      confirmDiscard: () => {
        restoreDraft();
        setDiscardConfirmOpen(false);
        onClose();
      },
      copy,
      doDelete: operations.doDelete,
      requestClose,
      requestConflictReload,
      retryEmbed,
      saveSettings: operations.saveSettings,
      togglePublished: operations.togglePublished,
    },
    draft: { draft, setDraft },
    load: {
      concurrencyConflict: operations.concurrencyConflict,
      embedErr,
      embedLoading,
      err: data.err,
      loading: data.loading,
      deleteUnavailableReason,
      mutationUnavailableReason,
    },
    model: {
      embed,
      embedText,
      form: data.form,
      formId,
      subs: data.subs,
      subsErr: data.subsErr,
      subsLoading: data.subsLoading,
    },
    operations: {
      closeLocked,
      deleting: operations.deleting,
      savingPublish: operations.savingPublish,
      savingSettings: operations.savingSettings,
    },
    overlays: {
      deleteConfirmOpen: operations.deleteConfirmOpen,
      discardConfirmOpen,
      reloadConfirmOpen,
      setDeleteConfirmOpen: operations.setDeleteConfirmOpen,
      setDiscardConfirmOpen,
      setReloadConfirmOpen,
    },
    permissions: { canAdmin, canMutate },
    shell: {
      detailTab,
      embedTab,
      setDetailTab,
      setEmbedTab,
      settingsDirty,
    },
  };
}

type FormDetailController = ReturnType<typeof useFormDetailController>;

export function FormDetailSlideover(props: Props): ReactElement {
  const controller = useFormDetailController(props);
  return <FormDetailSlideoverView controller={controller} />;
}

function FormDetailSlideoverView({
  controller,
}: {
  controller: FormDetailController;
}): ReactElement {
  const {
    actions,
    draft,
    load,
    model,
    operations,
    overlays,
    permissions,
    shell,
  } = controller;
  const {
    confirmDelete,
    confirmConflictReload,
    confirmDiscard,
    copy,
    doDelete,
    requestClose,
    requestConflictReload,
    retryEmbed,
    saveSettings,
    togglePublished,
  } = actions;
  const { draft: settingsDraft, setDraft } = draft;
  const {
    concurrencyConflict,
    deleteUnavailableReason,
    embedErr,
    embedLoading,
    err,
    loading,
    mutationUnavailableReason,
  } = load;
  const { embed, embedText, form, formId, subs, subsErr, subsLoading } = model;
  const { closeLocked, deleting, savingPublish, savingSettings } = operations;
  const {
    deleteConfirmOpen,
    discardConfirmOpen,
    reloadConfirmOpen,
    setDeleteConfirmOpen,
    setDiscardConfirmOpen,
    setReloadConfirmOpen,
  } = overlays;
  const { canAdmin, canMutate } = permissions;
  const { detailTab, embedTab, setDetailTab, setEmbedTab, settingsDirty } =
    shell;
  const actionUnavailableReason =
    mutationUnavailableReason ?? deleteUnavailableReason;
  const writeReasonId = "form-detail-write-permission";
  const closeLockReasonId = "form-detail-close-lock-reason";

  return (
    <>
      <div
        className="slideover-overlay slideover-overlay-v2"
        onClick={requestClose}
        aria-hidden="true"
        data-testid="form-detail-backdrop"
      />
      <aside
        className="slideover slideover-v2 slideover-lg form-detail-slideover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="form-slideover-title"
        aria-busy={
          loading || savingSettings || savingPublish || deleting || undefined
        }
      >
        <header className="slideover-header form-detail-header">
          {form ? (
            <FormDetailHeader
              form={form}
              formId={formId}
              canMutate={canMutate}
              savingPublish={savingPublish}
              settingsDirty={settingsDirty}
              mutationUnavailableReason={mutationUnavailableReason}
              writeReasonId={writeReasonId}
              onTogglePublished={togglePublished}
            />
          ) : (
            <div>
              <div className="slideover-eyebrow">Forms</div>
              <h2 id="form-slideover-title" className="slideover-title">
                {loading ? "Loading form details" : "Form unavailable"}
              </h2>
            </div>
          )}
          <button
            type="button"
            className="slideover-close"
            onClick={requestClose}
            disabled={closeLocked}
            aria-label="Close form details"
            aria-describedby={closeLocked ? closeLockReasonId : undefined}
          >
            ×
          </button>
          {closeLocked ? (
            <span
              id={closeLockReasonId}
              className="visually-hidden"
              role="status"
            >
              Close is locked while form work is in progress.
            </span>
          ) : null}
        </header>

        <div className="slideover-body form-detail-body">
          {loading && !form ? (
            <div
              aria-label="Loading form details"
              className="form-detail-loading"
            >
              <div className="skel" style={{ height: 18, width: "60%" }} />
              <div className="skel" style={{ height: 12, width: "40%" }} />
              <div className="skel" style={{ height: 120 }} />
            </div>
          ) : !form ? (
            <Notice tone="danger" title="Couldn’t load form">
              {err ?? "The form is unavailable or you no longer have access."}
            </Notice>
          ) : (
            <>
              {err && !actionUnavailableReason ? (
                <Notice tone="warning" title="Fresh details unavailable">
                  {err} The last loaded form remains visible.
                </Notice>
              ) : null}
              {actionUnavailableReason && !loading ? (
                <Notice
                  tone={concurrencyConflict ? "danger" : "warning"}
                  title={
                    concurrencyConflict
                      ? "Form changed elsewhere"
                      : "Editing is safely locked"
                  }
                  action={
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={requestConflictReload}
                    >
                      Reload current version
                    </button>
                  }
                >
                  {actionUnavailableReason}
                  {err && err !== actionUnavailableReason ? ` ${err}` : ""}
                </Notice>
              ) : null}
              <FormDetailWorkspace value={detailTab} onChange={setDetailTab}>
                {{
                  overview: <FormOverview form={form} submissions={subs} />,
                  share: (
                    <FormEmbedShareSection
                      canAdmin={canAdmin}
                      embed={embed}
                      embedError={embedErr}
                      embedLoading={embedLoading}
                      embedText={embedText}
                      formStatus={form.status}
                      tab={embedTab}
                      onCopy={copy}
                      onRetry={retryEmbed}
                      onTabChange={setEmbedTab}
                    />
                  ),
                  responses: (
                    <FormResponses
                      canAdmin={canAdmin}
                      formId={form.id}
                      submissions={subs}
                      error={subsErr}
                      loading={subsLoading}
                    />
                  ),
                  settings: (
                    <>
                      <FormDetailSettings
                        canMutate={canMutate}
                        draft={settingsDraft}
                        form={form}
                        mutationUnavailableReason={mutationUnavailableReason}
                        saving={savingSettings}
                        onDraftChange={setDraft}
                        onSave={saveSettings}
                        writeReasonId={writeReasonId}
                      />
                      {canAdmin ? (
                        <FormDangerZone
                          deleting={deleting}
                          unavailableReason={deleteUnavailableReason}
                          onDelete={doDelete}
                        />
                      ) : canMutate ? (
                        <Notice tone="neutral" title="Deletion is admin-only">
                          Editors can update form content and publication, but
                          only a workspace admin can permanently delete forms
                          and their response records.
                        </Notice>
                      ) : null}
                    </>
                  ),
                }}
              </FormDetailWorkspace>
            </>
          )}
        </div>
      </aside>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard unsaved form changes?"
        description="Your name, opt-in, redirect, spam, and field edits will return to the last saved form."
        confirmLabel="Discard changes"
        danger
        onConfirm={confirmDiscard}
        onClose={() => setDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        open={reloadConfirmOpen}
        title="Reload the current server version?"
        description="This discards your local form edits, then reloads the current server version so you can reconcile the change safely."
        confirmLabel="Discard and reload"
        danger
        onConfirm={confirmConflictReload}
        onClose={() => setReloadConfirmOpen(false)}
      />
      <ConfirmModal
        open={deleteConfirmOpen}
        title="Delete form?"
        description={
          form
            ? `"${form.name}" will be removed. Existing embeds will return 404. This cannot be undone.`
            : ""
        }
        danger
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={confirmDelete}
        onClose={() => {
          if (!deleting) setDeleteConfirmOpen(false);
        }}
      />
    </>
  );
}

function FormDetailWorkspace({
  value,
  onChange,
  children,
}: {
  value: DetailTab;
  onChange: (value: DetailTab) => void;
  children: Record<DetailTab, ReactElement>;
}): ReactElement {
  const tabs = useTabsInteraction({
    value,
    items: DETAIL_TABS,
    onChange,
    activation: "automatic",
  });
  return (
    <>
      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        className="form-detail-tabs"
        aria-label="Form detail sections"
      >
        {DETAIL_TABS.map((item) => (
          <button
            key={item.value}
            type="button"
            className="form-detail-tab"
            data-active={value === item.value || undefined}
            {...tabs.getTabProps(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="form-detail-panels">
        {DETAIL_TABS.map((item) => (
          <section
            key={item.value}
            {...tabs.getPanelProps(item.value)}
            aria-hidden={value !== item.value || undefined}
            className="form-detail-panel"
          >
            {children[item.value]}
          </section>
        ))}
      </div>
    </>
  );
}

function FormOverview({
  form,
  submissions,
}: {
  form: FormDetail;
  submissions: FormSubmission[] | null;
}): ReactElement {
  return (
    <div className="form-detail-overview">
      <Notice
        tone={form.status === "published" ? "success" : "neutral"}
        title={
          form.status === "published"
            ? "Live and accepting responses"
            : form.status === "archived"
              ? "Archived and unavailable publicly"
              : "Draft — not yet public"
        }
      >
        Review sharing, response access, and settings in the focused tabs before
        changing the form lifecycle.
      </Notice>
      <dl className="form-detail-facts">
        <div>
          <dt>Public path</dt>
          <dd className="mono">/forms/{form.slug}</dd>
        </div>
        <div>
          <dt>Consent flow</dt>
          <dd>
            {form.optInMode === "double" ? "Double opt-in" : "Single opt-in"}
          </dd>
        </div>
        <div>
          <dt>Loaded responses</dt>
          <dd>
            {submissions ? submissions.length.toLocaleString() : "Restricted"}
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{fmtDate(form.updatedAt)}</dd>
        </div>
      </dl>
    </div>
  );
}

function FormResponses({
  canAdmin,
  error,
  formId,
  loading,
  submissions,
}: {
  canAdmin: boolean;
  error: string | null;
  formId: string;
  loading: boolean;
  submissions: FormSubmission[] | null;
}): ReactElement {
  if (!canAdmin) {
    return (
      <Notice tone="warning" title="Response details are admin-only">
        Submission emails, custom fields, IP-derived metadata, and exports are
        confidential personal data. Ask a workspace admin for response-level
        access.
      </Notice>
    );
  }
  return (
    <div className="form-detail-responses">
      <Notice tone="neutral" title="Confidential admin workspace">
        The desktop view loads at most the 1,000 most recent response rows. Its
        charts and recent list can therefore be a sample; Export CSV retrieves
        the complete available history. Handle email and response data under
        your privacy and retention policy.
      </Notice>
      <SubmissionsAnalytics
        formId={formId}
        submissions={submissions}
        loading={loading}
      />
      {error ? (
        <Notice tone="danger" title="Couldn’t load responses">
          {error}
        </Notice>
      ) : null}
      {submissions && submissions.length > 0 ? (
        <div>
          <div className="label">Recent submissions</div>
          <div className="list">
            {submissions.slice(0, 5).map((submission) => (
              <div key={submission.id} className="list-row form-response-row">
                <div className="form-response-email">{submission.email}</div>
                <div className="muted tabular form-response-date">
                  {fmtDate(submission.submittedAt)}
                </div>
                <div className="form-response-status">
                  {submissionBadge(submission.status)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FormDangerZone({
  deleting,
  onDelete,
  unavailableReason,
}: {
  deleting: boolean;
  onDelete: () => void;
  unavailableReason: string | null;
}): ReactElement {
  const reasonId = unavailableReason
    ? "form-detail-delete-unavailable"
    : undefined;
  return (
    <div className="danger-zone form-detail-danger-zone">
      <strong>Danger zone</strong>
      <p className="muted">
        Deleting this form removes its submission records and breaks every
        hosted link and embed. This cannot be undone.
      </p>
      <button
        type="button"
        className="btn btn-danger btn-sm"
        onClick={onDelete}
        disabled={deleting || Boolean(unavailableReason)}
        aria-describedby={reasonId}
      >
        {deleting ? "Deleting…" : "Delete form"}
      </button>
      {unavailableReason ? (
        <p id={reasonId} className="muted form-detail-danger-reason">
          Deletion is locked until the current server revision is reconciled.
        </p>
      ) : null}
    </div>
  );
}

function FormEmbedShareSection({
  canAdmin,
  embed,
  embedError,
  embedLoading,
  embedText,
  formStatus,
  tab,
  onCopy,
  onRetry,
  onTabChange,
}: {
  canAdmin: boolean;
  embed: CanonicalFormEmbed | null;
  embedError: string | null;
  embedLoading: boolean;
  embedText: string;
  formStatus: FormStatus;
  tab: EmbedTab;
  onCopy: (text: string, label: string) => Promise<void>;
  onRetry: () => void;
  onTabChange: (tab: EmbedTab) => void;
}): ReactElement {
  const ready = Boolean(embed && embedText && !embedLoading && !embedError);
  const copyLabel =
    tab === "hosted"
      ? "Hosted form URL"
      : `${tab === "script" ? "Script" : tab === "react" ? "React" : "Iframe"} embed`;
  const instructions =
    tab === "hosted"
      ? "Share this server-confirmed URL directly or use it in a campaign CTA."
      : embed?.instructions;
  const descriptionId = "form-embed-share-description";

  return (
    <section aria-labelledby="form-embed-share-title" aria-busy={embedLoading}>
      <div id="form-embed-share-title" className="label">
        Share &amp; embed
      </div>
      <p
        id={descriptionId}
        className="muted"
        style={{ fontSize: 11, lineHeight: 1.5, margin: "0 0 8px" }}
      >
        Generated by the server from this workspace&apos;s configured public
        forms host.
      </p>
      <ChoiceGroup
        legend="Share format"
        value={tab}
        onChange={onTabChange}
        className="tabs"
        optionClassName="tab"
        style={{ marginBottom: 8 }}
        options={(
          [
            ["hosted", "Hosted page"],
            ["iframe", "Iframe"],
            ["script", "Script"],
            ["react", "React"],
          ] as [EmbedTab, string][]
        ).map(([value, label]) => ({
          value,
          label,
          disabled: !canAdmin,
          className: tab === value ? "is-active" : undefined,
        }))}
      />

      {embedLoading ? (
        <Notice
          tone="neutral"
          title="Loading canonical share details"
          announcement="polite"
          style={{ marginBottom: 8 }}
        >
          Confirming the public host and current server-generated output.
        </Notice>
      ) : null}
      {embedError ? (
        <Notice
          tone="danger"
          title="Share details unavailable"
          announcement="assertive"
          style={{ marginBottom: 8 }}
          action={
            canAdmin ? (
              <button type="button" className="btn btn-sm" onClick={onRetry}>
                Retry
              </button>
            ) : null
          }
        >
          {embedError} Copying, opening, previews, and QR generation stay
          disabled until the server confirms the canonical URL.
        </Notice>
      ) : null}

      <div className="copy-row">
        <textarea
          aria-label={copyLabel}
          aria-describedby={descriptionId}
          readOnly
          disabled={!ready}
          value={ready ? embedText : ""}
          placeholder="Canonical server output is unavailable"
          rows={tab === "react" ? 8 : 5}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
      </div>
      {ready && embed ? (
        <div
          className="muted"
          style={{ fontSize: 11, lineHeight: 1.5, marginTop: 6 }}
        >
          <span className="badge">
            {tab === "hosted" ? "URL" : embed.language}
          </span>{" "}
          {instructions} Served by {embed.publicHost}.
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void onCopy(embedText, copyLabel)}
          disabled={!ready}
        >
          Copy
        </button>
        {tab === "hosted" ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => (ready ? void openHostedForm(embedText) : undefined)}
            disabled={!ready}
          >
            Open
          </button>
        ) : null}
      </div>

      {ready && embed ? (
        <EmbedPreviewCard publicUrl={embed.publicUrl} status={formStatus} />
      ) : null}
    </section>
  );
}

function FormDetailHeader({
  form,
  formId,
  canMutate,
  mutationUnavailableReason,
  savingPublish,
  settingsDirty,
  writeReasonId,
  onTogglePublished,
}: {
  form: FormDetail;
  formId: string;
  canMutate: boolean;
  mutationUnavailableReason: string | null;
  savingPublish: boolean;
  settingsDirty: boolean;
  writeReasonId: string;
  onTogglePublished: () => Promise<void>;
}): ReactElement {
  const publishUnavailable =
    savingPublish ||
    settingsDirty ||
    Boolean(mutationUnavailableReason) ||
    form.status === "archived" ||
    !canMutate;
  const publishReason = !canMutate
    ? "Viewer access is read-only; an editor or admin can publish and edit forms."
    : form.status === "archived"
      ? "Archived forms must be restored before their publication status can change."
      : mutationUnavailableReason
        ? mutationUnavailableReason
        : settingsDirty
          ? "Save or discard settings changes before changing publication."
          : null;
  const publishReasonId = publishReason
    ? "form-detail-publish-unavailable"
    : undefined;
  return (
    <div className="form-detail-heading">
      <div className="slideover-eyebrow">Form workspace</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <h2 id="form-slideover-title" className="slideover-title">
          {form.name}
        </h2>
        {statusBadge(form.status)}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        /{form.slug} ·{" "}
        {form.optInMode === "double" ? "Double opt-in" : "Single opt-in"}
      </div>
      <PendingSyncStatus
        path={`/api/v1/forms/${encodeURIComponent(formId)}`}
        compact
      />
      {!canMutate ? (
        <p
          id={writeReasonId}
          className="muted"
          style={{ fontSize: 11, margin: "8px 0 0" }}
        >
          Viewer access is read-only; an editor or admin can publish and edit
          forms.
        </p>
      ) : null}
      {canMutate && publishReason ? (
        <p
          id={publishReasonId}
          className="muted"
          style={{ fontSize: 11, margin: "8px 0 0" }}
        >
          {publishReason}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (publishUnavailable) return;
            void onTogglePublished();
          }}
          aria-disabled={publishUnavailable || undefined}
          aria-describedby={
            publishReason
              ? canMutate
                ? publishReasonId
                : writeReasonId
              : undefined
          }
        >
          {savingPublish
            ? "Saving…"
            : form.status === "published"
              ? "Move to draft"
              : "Publish"}
        </button>
      </div>
    </div>
  );
}

interface FormDetailSettingsProps {
  canMutate: boolean;
  draft: FormSettingsDraft;
  form: FormDetail;
  mutationUnavailableReason: string | null;
  saving: boolean;
  onDraftChange: Dispatch<SetStateAction<FormSettingsDraft>>;
  onSave: () => Promise<void>;
  writeReasonId: string;
}

function FormDetailSettings({
  canMutate,
  draft,
  form,
  mutationUnavailableReason,
  onDraftChange,
  onSave,
  saving,
  writeReasonId,
}: FormDetailSettingsProps): ReactElement {
  const canonicalLabels = canonicalFieldLabels(form);
  const settingsUnavailable =
    saving || !canMutate || Boolean(mutationUnavailableReason);
  const mutationReasonId = "form-detail-settings-unavailable";
  const settingsDescriptionId = !canMutate
    ? writeReasonId
    : mutationUnavailableReason
      ? mutationReasonId
      : undefined;
  const updateDraft = (patch: Partial<FormSettingsDraft>): void => {
    onDraftChange((current) => ({ ...current, ...patch }));
  };
  return (
    <div className="form-detail-settings">
      {mutationUnavailableReason ? (
        <span id={mutationReasonId} className="visually-hidden">
          {mutationUnavailableReason}
        </span>
      ) : null}
      <div>
        <h3>Form settings</h3>
        <p className="muted">
          Configure the visitor outcome and consent flow. Changes stay local
          until you save them.
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="form-name">
          Name
        </label>
        <input
          id="form-name"
          type="text"
          className="input"
          value={draft.name}
          readOnly={settingsUnavailable}
          aria-describedby={settingsDescriptionId}
          onChange={(event) => updateDraft({ name: event.target.value })}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="form-optin">
          Opt-in mode
        </label>
        <select
          id="form-optin"
          className="input"
          value={draft.optInMode}
          disabled={settingsUnavailable}
          aria-describedby={settingsDescriptionId}
          onChange={(event) => {
            if (settingsUnavailable) return;
            updateDraft({ optInMode: event.target.value as FormOptInMode });
          }}
        >
          <option value="single">Single (instant)</option>
          <option value="double">Double (confirm by email)</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="form-success">
          Success message
        </label>
        <textarea
          id="form-success"
          className="input"
          style={{ height: 60, padding: 8 }}
          value={draft.successMessage}
          readOnly={settingsUnavailable}
          aria-describedby={settingsDescriptionId}
          onChange={(event) =>
            updateDraft({ successMessage: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="form-redirect">
          Success redirect URL
        </label>
        <input
          id="form-redirect"
          type="url"
          className="input"
          placeholder="https://example.com/thanks"
          value={draft.redirectUrl}
          readOnly={settingsUnavailable}
          aria-describedby={settingsDescriptionId}
          onChange={(event) => updateDraft({ redirectUrl: event.target.value })}
        />
      </div>
      {draft.fieldWireMode !== "legacy" ? (
        <div style={{ marginTop: 8 }}>
          <div className="label">Fields</div>
          <Notice
            tone={draft.fieldWireMode === "unsupported" ? "warning" : "neutral"}
            title="Field structure is read-only"
          >
            {fieldWireModeNotice(draft.fieldWireMode)} The fields below are
            informational; a settings save will not write the structure.
            {canonicalLabels.length > 0 ? (
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {canonicalLabels.map((label, index) => (
                  <li key={`${index}-${label}`}>{label}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        </div>
      ) : (
        <FormFieldsEditor
          initial={draft.fields}
          onChange={(fields) => updateDraft({ fields, fieldsDirty: true })}
          disabled={settingsUnavailable}
        />
      )}
      <div style={{ marginTop: 16 }}>
        <FormSpamSettings
          value={draft.spam}
          onChange={(spam) => updateDraft({ spam })}
          disabled={settingsUnavailable}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            if (settingsUnavailable) return;
            void onSave();
          }}
          disabled={saving}
          aria-disabled={settingsUnavailable || undefined}
          aria-describedby={settingsDescriptionId}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
