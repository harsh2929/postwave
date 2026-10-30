// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ArrowLeft, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { EditorShell } from "@/components/editor/editor-shell";
import { compileMjmlSource } from "@/components/editor/compile-mjml";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage, isApiError } from "@/lib/api";
import { getSavedBlock, listSavedBlocks, type SavedBlock } from "@/lib/content-library-api";
import {
  createCampaignTemplate,
  campaignTemplateCapabilities,
  templateSlugFromName,
  updateCampaignTemplate,
  type CampaignTemplate,
} from "@/lib/campaign-templates-api";
import {
  locateRegionInSource,
  readTemplateVariableDrafts,
  regionSourceFormat,
  serializeTemplateVariableDrafts,
  templateVariablesFingerprint,
  validateTemplateVariableDrafts,
  type CampaignTemplateRegion,
  type TemplateVariableDraft,
} from "@/lib/template-regions-api";
import { asRoute } from "@/lib/typed-routes";
import { savedBlockSource } from "@/lib/template-saved-blocks";
import {
  applyLinkedBlockUpdate,
  linkedBlockOccurrenceCount,
  readLinkedTemplateBlocks,
  type LinkedTemplateBlock,
} from "@/lib/template-linked-blocks";
import { workspaceBrandBlocks, type WorkspaceMJMLBlock } from "@/components/editor/moosewave-email-blocks";
import { workspaceSettingsApi } from "@/lib/workspace-settings-api";
import {
  browserTemplateRecoveryStorage,
  clearTemplateRecovery,
  readTemplateRecovery,
  templateRecoveryKey,
  writeTemplateRecovery,
} from "@/lib/template-editor-recovery";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { useTemplateGenerationAvailability } from "@/lib/use-template-generation-availability";

import { TemplatePreviewWithVars } from "./template-preview-with-vars";
import { TemplateAssetPicker } from "./template-asset-picker";
import { TemplatePreflightCard } from "./template-preflight-card";
import { TemplateRegionsPanel } from "./template-regions-panel";
import { TemplateVariablesEditor } from "./template-variables-editor";

const GOALS = [
  "newsletter",
  "promotional",
  "announcement",
  "welcome",
  "re_engagement",
  "transactional",
  "automation",
] as const;
const TEMPLATE_DESIGN_MODES: Array<"blocks" | "clients"> = [
  "blocks",
  "clients",
];

const CrossClientPreview = dynamic(
  () =>
    import("@/components/editor/cross-client-preview").then(
      (module) => module.CrossClientPreview,
    ),
  { ssr: false },
);

const AdaptTemplateDialog = dynamic(
  () => import("./template-actions").then((module) => module.AdaptTemplateDialog),
  { ssr: false },
);

const TemplateSavedBlockPicker = dynamic(
  () =>
    import("./template-saved-block-picker").then(
      (module) => module.TemplateSavedBlockPicker,
    ),
  { ssr: false },
);

const ContentTestSendDialog = dynamic(
  () =>
    import("@/components/content-test-send-dialog").then(
      (module) => module.ContentTestSendDialog,
    ),
  { ssr: false },
);

type Surface = "code" | "design";
type CodeFormat = "html" | "mjml";

function blockCopyName(original: string): string {
  const suffix = " · Block design";
  const encoder = new TextEncoder();
  let stem = "";
  for (const character of original.trim()) {
    if (encoder.encode(stem + character + suffix).length > 200) break;
    stem += character;
  }
  return `${stem.trim() || "Template"}${suffix}`;
}

interface TemplateDraftSnapshot {
  name: string;
  subject: string;
  previewText: string;
  description: string;
  category: string;
  goal: string;
  tagsInput: string;
  bodyHtml: string;
  bodyMjml: string;
  /** Serialized merge-variable drafts (see templateVariablesFingerprint). */
  variables: string;
  linkedBlocks?: string;
}

function initialDraftSnapshot(
  template: CampaignTemplate | undefined,
): TemplateDraftSnapshot {
  return {
    name: template?.name ?? "",
    subject: template?.subject ?? "",
    previewText: template?.preview_text ?? "",
    description: template?.description ?? "",
    category: template?.category ?? "",
    goal: template?.goal || "newsletter",
    tagsInput: (template?.tags ?? [])
      .filter((tag) => !tag.includes(":"))
      .join(", "),
    bodyHtml: template?.body_html ?? "",
    bodyMjml: template?.body_mjml ?? "",
    variables: templateVariablesFingerprint(
      readTemplateVariableDrafts(template?.variables),
    ),
    linkedBlocks: JSON.stringify(readLinkedTemplateBlocks(template?.design_metadata)),
  };
}

function sameDraft(
  left: TemplateDraftSnapshot,
  right: TemplateDraftSnapshot,
): boolean {
  return (
    left.name === right.name &&
    left.subject === right.subject &&
    left.previewText === right.previewText &&
    left.description === right.description &&
    left.category === right.category &&
    left.goal === right.goal &&
    left.tagsInput === right.tagsInput &&
    left.bodyHtml === right.bodyHtml &&
    left.bodyMjml === right.bodyMjml &&
    left.variables === right.variables &&
    (left.linkedBlocks ?? "[]") === (right.linkedBlocks ?? "[]")
  );
}

/**
 * Hand-authored template create/edit form (TMPL-004). Two authoring surfaces:
 *
 *  - "Design" reuses the shared EditorShell (Blocks/MJML) — the same editor the
 *    sequence route uses — so authoring isn't a bespoke fork.
 *  - "Code" is a raw HTML/MJML source editor with the sandboxed live preview,
 *    which doubles as the import path (paste exported source — TMPL-028).
 *
 * Saving always sends the COMPLETE body, never a partial: the backend treats a
 * present body_html/body_mjml as a FULL REPLACE, so a partial would drop
 * blocks.
 */
export function TemplateEditorForm({
  intent,
  template,
  recoveryScope,
  initialSurface,
}: {
  intent: "create" | "edit";
  template?: CampaignTemplate;
  recoveryScope?: { tenantId: string; userId: string };
  initialSurface?: Surface;
}) {
  const router = useRouter();
  const generationAvailability = useTemplateGenerationAvailability(intent === "edit");
  const initialDraft = initialDraftSnapshot(template);
  const [name, setName] = useState(initialDraft.name);
  const [subject, setSubject] = useState(initialDraft.subject);
  const [previewText, setPreviewText] = useState(initialDraft.previewText);
  const [description, setDescription] = useState(initialDraft.description);
  const [category, setCategory] = useState(initialDraft.category);
  const [goal, setGoal] = useState(initialDraft.goal);
  const [surface, setSurface] = useState<Surface>(
    template?.body_html?.trim() && !template?.body_mjml?.trim() ? "code" : initialSurface ?? "design",
  );
  const [format, setFormat] = useState<CodeFormat>(
    template?.body_mjml?.trim() ? "mjml" : "html",
  );
  const [bodyHtml, setBodyHtml] = useState(initialDraft.bodyHtml);
  const [bodyMjml, setBodyMjml] = useState(initialDraft.bodyMjml);
  const [linkedBlocks, setLinkedBlocks] = useState<LinkedTemplateBlock[]>(() =>
    readLinkedTemplateBlocks(template?.design_metadata),
  );
  const [latestBlocks, setLatestBlocks] = useState<Record<string, SavedBlock | null>>({});
  // TMPL-041: editable human tags. System tags (containing ':') are hidden
  // from the field but preserved on save so a save never drops them.
  const systemTags = (template?.tags ?? []).filter((t) => t.includes(":"));
  const [tagsInput, setTagsInput] = useState(initialDraft.tagsInput);
  // Merge variables (desktop parity). Edited here and saved with the rest of
  // the draft; a PATCH carrying `variables` is a FULL REPLACE, so they are sent
  // only when they changed and every stored field is carried through.
  const [variables, setVariables] = useState<TemplateVariableDraft[]>(() =>
    readTemplateVariableDrafts(template?.variables),
  );
  const variablesFingerprint = templateVariablesFingerprint(variables);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const sourceFileRef = useRef<HTMLInputElement>(null);
  const [pendingSelection, setPendingSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [regionNotice, setRegionNotice] = useState<string | null>(null);
  const [savedDraft, setSavedDraft] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [creatingBlockCopy, setCreatingBlockCopy] = useState(false);
  const [compilingForSave, setCompilingForSave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mjmlPreview, setMjmlPreview] = useState<{
    source: string;
    html: string;
    warnings: string[];
  } | null>(null);
  const [mjmlPreviewError, setMjmlPreviewError] = useState<string | null>(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [savedBlockPickerOpen, setSavedBlockPickerOpen] = useState(false);
  const [selectedSnippetSource, setSelectedSnippetSource] = useState("");
  const snippetInsertionRef = useRef<{ start: number; end: number; source: string; format: CodeFormat } | null>(null);
  const [workspaceBlocks, setWorkspaceBlocks] = useState<WorkspaceMJMLBlock[]>([]);
  const [brandBlocks, setBrandBlocks] = useState<WorkspaceMJMLBlock[]>([]);
  const [workspaceBlockError, setWorkspaceBlockError] = useState<string | null>(null);
  const [adaptOpen, setAdaptOpen] = useState(false);
  const [adaptActivated, setAdaptActivated] = useState(false);
  const adaptTriggerRef = useRef<HTMLButtonElement>(null);
  const [clientPreview, setClientPreview] = useState<{
    format: CodeFormat;
    source: string;
    html: string;
  } | null>(null);
  const [pendingImport, setPendingImport] = useState<{
    name: string;
    format: CodeFormat;
    source: string;
  } | null>(null);
  const [recoverableDraft, setRecoverableDraft] =
    useState<TemplateDraftSnapshot | null>(null);
  const [recoveryProblem, setRecoveryProblem] = useState(false);
  const [checkedRecoveryKey, setCheckedRecoveryKey] = useState<string | null>(
    null,
  );
  const persistInFlight = useRef(false);
  const blockCopyInFlight = useRef(false);
  const sourceSaveInFlight = useRef(false);
  const missingConcurrencyToken = intent === "edit" && !template?.etag?.trim();

  const documentId = template?.id ?? "new-template";
  const workspaceTenantId = recoveryScope?.tenantId || template?.tenant_id || "";
  const editorWorkspaceBlocks = useMemo(() => [...brandBlocks, ...workspaceBlocks], [brandBlocks, workspaceBlocks]);
  const activeSource = format === "html" ? bodyHtml : bodyMjml;
  const linkedBlocksFingerprint = JSON.stringify(linkedBlocks);
  const sourceLineCount = activeSource ? activeSource.split("\n").length : 0;
  const recoveryKey = recoveryScope
    ? templateRecoveryKey({
        ...recoveryScope,
        templateId: documentId,
        etag: template?.etag,
      })
    : null;
  const recoveryChecked = checkedRecoveryKey === recoveryKey;
  const currentDraft: TemplateDraftSnapshot = useMemo(
    () => ({
      name,
      subject,
      previewText,
      description,
      category,
      goal,
      tagsInput,
      bodyHtml,
      bodyMjml,
      variables: variablesFingerprint,
      linkedBlocks: linkedBlocksFingerprint,
    }),
    [
      name,
      subject,
      previewText,
      description,
      category,
      goal,
      tagsInput,
      bodyHtml,
      bodyMjml,
      variablesFingerprint,
      linkedBlocksFingerprint,
    ],
  );
  // The route owns the save boundary. EditorShell receives live values so its
  // old prop-diff could become clean on every keystroke, and it never covered
  // metadata or the raw-code surface. Compare the whole form to the last
  // successfully persisted snapshot instead.
  const draftChanged = !sameDraft(currentDraft, savedDraft);
  useUnsavedChangesGuard(draftChanged);
  const previewableHTML = bodyMjml.trim()
    ? mjmlPreview?.source === bodyMjml &&
      mjmlPreview.warnings.length === 0
      ? mjmlPreview.html
      : ""
    : bodyHtml;
  const testableHTML = previewableHTML;
  const clientPreviewCurrent =
    clientPreview?.format === format &&
    clientPreview.source === activeSource &&
    clientPreview.html === previewableHTML;

  useEffect(() => {
    if (!recoveryKey) return;
    const storage = browserTemplateRecoveryStorage();
    const recovered = storage
      ? readTemplateRecovery(storage, recoveryKey)
      : null;
    if (recovered && !sameDraft(recovered, initialDraftSnapshot(template))) {
      setRecoverableDraft(recovered);
    }
    setCheckedRecoveryKey(recoveryKey);
  }, [recoveryKey, template]);

  useEffect(() => {
    if (!recoveryKey || !recoveryChecked || recoverableDraft) return;
    const writeSnapshot = (reportStatus: boolean) => {
      const storage = browserTemplateRecoveryStorage();
      if (!storage) {
        if (reportStatus) setRecoveryProblem(true);
        return;
      }
      if (sameDraft(currentDraft, savedDraft)) {
        clearTemplateRecovery(storage, recoveryKey);
        if (reportStatus) setRecoveryProblem(false);
      } else {
        const written = writeTemplateRecovery(
          storage,
          recoveryKey,
          currentDraft,
        );
        if (reportStatus) setRecoveryProblem(!written);
      }
    };
    const timer = setTimeout(() => writeSnapshot(true), 800);
    const onPageHide = () => writeSnapshot(false);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [
    recoveryKey,
    recoveryChecked,
    recoverableDraft,
    currentDraft,
    savedDraft,
  ]);

  const restoreDraft = () => {
    if (!recoverableDraft) return;
    setName(recoverableDraft.name);
    setSubject(recoverableDraft.subject);
    setPreviewText(recoverableDraft.previewText);
    setDescription(recoverableDraft.description);
    setCategory(recoverableDraft.category);
    setGoal(recoverableDraft.goal);
    setTagsInput(recoverableDraft.tagsInput);
    setBodyHtml(recoverableDraft.bodyHtml);
    setBodyMjml(recoverableDraft.bodyMjml);
    if (recoverableDraft.linkedBlocks) {
      try {
        setLinkedBlocks(readLinkedTemplateBlocks({ moosewave_linked_blocks: JSON.parse(recoverableDraft.linkedBlocks) }));
      } catch {
        setLinkedBlocks([]);
      }
    }
    try {
      setVariables(
        readTemplateVariableDrafts(
          JSON.parse(recoverableDraft.variables) as unknown,
        ),
      );
    } catch {
      setVariables([]);
    }
    setFormat(recoverableDraft.bodyMjml.trim() ? "mjml" : "html");
    setSurface("code");
    setRecoverableDraft(null);
  };

  useEffect(() => {
    if (surface !== "code" || !bodyMjml.trim()) return;
    const controller = new AbortController();
    const debounce = setTimeout(() => {
      void compileMjmlSource(bodyMjml, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setMjmlPreview({
            source: bodyMjml,
            html: result.html,
            warnings: result.errors.map(
              (warning) =>
                warning.formattedMessage ||
                warning.message ||
                "MJML validation warning",
            ),
          });
          setMjmlPreviewError(null);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setMjmlPreviewError(
            cause instanceof Error ? cause.message : "MJML preview failed.",
          );
        });
    }, 600);
    return () => {
      clearTimeout(debounce);
      controller.abort();
    };
  }, [bodyMjml, surface]);

  useEffect(() => {
    if (surface !== "design" || !workspaceTenantId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const loaded: WorkspaceMJMLBlock[] = [];
        let before: string | undefined;
        const seenCursors = new Set<string>();
        let pages = 0;
        do {
          const page = await listSavedBlocks({
            tenantId: workspaceTenantId,
            before,
            limit: 200,
            signal: controller.signal,
          });
          for (const block of page.items) {
            const source = savedBlockSource(block, "mjml");
            if (source) loaded.push({ id: block.id, name: block.name, source });
          }
          pages += 1;
          before = page.nextCursor ?? undefined;
          if (before && seenCursors.has(before)) {
            throw new Error("Saved-block pagination repeated a cursor.");
          }
          if (before) seenCursors.add(before);
        } while (before && pages < 5 && loaded.length < 500 && !controller.signal.aborted);
        if (controller.signal.aborted) return;
        setWorkspaceBlocks(loaded);
        setWorkspaceBlockError(null);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setWorkspaceBlockError(
            cause instanceof Error ? cause.message : "Workspace blocks could not be loaded.",
          );
        }
      }
    })();
    return () => controller.abort();
  }, [surface, workspaceTenantId]);

  useEffect(() => {
    setLatestBlocks({});
    if (!workspaceTenantId || linkedBlocks.length === 0) return;
    const controller = new AbortController();
    void Promise.all(linkedBlocks.map(async (link) => {
      try {
        const block = await getSavedBlock({ tenantId: workspaceTenantId, id: link.id, signal: controller.signal });
        return [link.id, block] as const;
      } catch {
        return [link.id, null] as const;
      }
    })).then((rows) => {
      if (!controller.signal.aborted) setLatestBlocks(Object.fromEntries(rows));
    });
    return () => controller.abort();
  }, [workspaceTenantId, linkedBlocks]);

  useEffect(() => {
    if (surface !== "design" || !workspaceTenantId) return;
    const controller = new AbortController();
    void workspaceSettingsApi.get({ signal: controller.signal }).then((settings) => {
      if (!controller.signal.aborted && settings.tenant_id === workspaceTenantId) {
        setBrandBlocks(workspaceBrandBlocks(settings));
      }
    }).catch(() => {
      // Settings are optional; built-in Moosewave blocks and saved blocks remain usable.
    });
    return () => controller.abort();
  }, [surface, workspaceTenantId]);

  const persist = async (body: {
    body_html: string;
    body_mjml: string;
  }): Promise<void> => {
    if (!name.trim()) {
      setError("A template name is required.");
      return;
    }
    if (!subject.trim()) {
      setError("A subject line is required.");
      return;
    }
    if (!body.body_html?.trim() && !body.body_mjml?.trim()) {
      setError("Add some HTML or MJML source before saving.");
      return;
    }
    const variablesProblem = validateTemplateVariableDrafts(variables);
    if (variablesProblem) {
      setError(variablesProblem);
      return;
    }
    if (missingConcurrencyToken) {
      setError(
        "This editor does not have a fresh template version. Reload the page before saving.",
      );
      return;
    }
    if (persistInFlight.current) return;
    persistInFlight.current = true;
    setSaving(true);
    setError(null);
    // Merge edited human tags with the preserved system tags — updates
    // full-replace the tags array, so omitting system tags would wipe them.
    const humanTags = tagsInput
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const tags = Array.from(new Set([...systemTags, ...humanTags]));
    // Omitted `variables` leaves the stored set untouched; present replaces it.
    const variablesChanged = variablesFingerprint !== savedDraft.variables;
    const variablesPatch = variablesChanged
      ? { variables: serializeTemplateVariableDrafts(variables) }
      : {};
    const linkedBlocksPatch = linkedBlocksFingerprint !== savedDraft.linkedBlocks
      ? { design_metadata: {
          ...(template?.design_metadata ?? {}),
          moosewave_linked_blocks: linkedBlocks,
        } }
      : {};
    try {
      const saved =
        intent === "edit" && template
          ? await updateCampaignTemplate(
              template.id,
              {
                name: name.trim(),
                subject: subject.trim(),
                preview_text: previewText.trim(),
                description: description.trim(),
                category: category.trim(),
                goal,
                tags,
                ...body,
                ...linkedBlocksPatch,
                ...variablesPatch,
              },
              template.etag ?? "",
            )
          : await createCampaignTemplate({
              slug: templateSlugFromName(name),
              name: name.trim(),
              subject: subject.trim(),
              preview_text: previewText.trim(),
              description: description.trim(),
              category: category.trim(),
              goal,
              tags,
              ...body,
              ...linkedBlocksPatch,
              ...variablesPatch,
            });
      setSavedDraft({
        name,
        subject,
        previewText,
        description,
        category,
        goal,
        tagsInput,
        bodyHtml: body.body_html,
        bodyMjml: body.body_mjml,
        variables: variablesFingerprint,
        linkedBlocks: linkedBlocksFingerprint,
      });
      setBodyHtml(body.body_html);
      setBodyMjml(body.body_mjml);
      const storage = browserTemplateRecoveryStorage();
      if (recoveryKey && storage) clearTemplateRecovery(storage, recoveryKey);
      toast.success(
        intent === "edit" ? "Template updated" : "Template created",
      );
      router.push(`/app/templates/${saved.id}`);
      router.refresh();
    } catch (err) {
      if (isApiError(err) && (err.status === 412 || err.status === 428)) {
        setError(
          "Someone changed this template after you opened it. Your work is still here—copy anything you need, then reload to edit the latest version.",
        );
        return;
      }
      setError(
        apiErrorMessage(
          err,
          intent === "edit"
            ? "Could not update the template."
            : "Could not create the template.",
        ),
      );
    } finally {
      persistInFlight.current = false;
      setSaving(false);
    }
  };

  const saveFromSurface = async () => {
    if (sourceSaveInFlight.current) return;
    sourceSaveInFlight.current = true;
    try {
      if (format === "html") {
        if (bodyMjml.trim()) {
          setError(
            "MJML is still the source. Use the conversion action before saving HTML.",
          );
          return;
        }
        await persist({ body_mjml: "", body_html: bodyHtml });
        return;
      }
      if (!bodyMjml.trim()) {
        setError("Add MJML source before saving.");
        return;
      }
      setCompilingForSave(true);
      setError(null);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let compiled: Awaited<ReturnType<typeof compileMjmlSource>>;
      try {
        compiled = await compileMjmlSource(bodyMjml, controller.signal);
      } finally {
        clearTimeout(timeout);
      }
      if (compiled.errors.length > 0) {
        setError("Fix the MJML validation warnings before saving.");
        return;
      }
      await persist({ body_mjml: bodyMjml, body_html: "" });
    } catch (cause) {
      setError(
        cause instanceof DOMException && cause.name === "AbortError"
          ? "MJML compile timed out. Please try again."
          : cause instanceof Error
            ? cause.message
            : "Could not compile MJML.",
      );
    } finally {
      sourceSaveInFlight.current = false;
      setCompilingForSave(false);
    }
  };

  const createBlockCopy = async () => {
    if (!template || intent !== "edit" || draftChanged || blockCopyInFlight.current) return;
    blockCopyInFlight.current = true;
    setCreatingBlockCopy(true);
    setError(null);
    try {
      const copyName = blockCopyName(template.name);
      const copySlug = templateSlugFromName(copyName).slice(0, 70).replace(/-+$/u, "");
      const copy = await createCampaignTemplate({
        slug: `${copySlug}-${Date.now().toString(36)}`,
        name: copyName,
        subject: template.subject,
        preview_text: template.preview_text,
        description: template.description,
        category: template.category,
        goal: template.goal || "newsletter",
        tags: (template.tags ?? []).filter((tag) => !tag.includes(":")),
        variables: template.variables ?? [],
        body_html: "",
        body_mjml: "",
      });
      toast.success("Block design copy created", {
        description: "Your original HTML template is unchanged.",
      });
      router.push(`/app/templates/${copy.id}/edit`);
      router.refresh();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not create a block design copy."));
    } finally {
      blockCopyInFlight.current = false;
      setCreatingBlockCopy(false);
    }
  };

  const insertSourceText = (insertion: string, at?: { start: number; end: number }) => {
    const textarea = sourceRef.current;
    if (!textarea || (format === "html" && bodyMjml.trim())) return;
    const value = format === "html" ? bodyHtml : bodyMjml;
    const start = at?.start ?? textarea.selectionStart;
    const end = at?.end ?? textarea.selectionEnd;
    const next = value.slice(0, start) + insertion + value.slice(end);
    if (format === "html") {
      setBodyHtml(next);
      setBodyMjml("");
    } else {
      setBodyMjml(next);
      setBodyHtml("");
    }
    setPendingSelection({
      start: start + insertion.length,
      end: start + insertion.length,
    });
  };

  const wrapSelectionInCondition = (key: string) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) return;
    const textarea = sourceRef.current;
    if (!textarea || (format === "html" && bodyMjml.trim())) return;
    const value = format === "html" ? bodyHtml : bodyMjml;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    const body = selected || (format === "mjml" ? "<mj-text>Conditional content</mj-text>" : "<p>Conditional content</p>");
    insertSourceText(`{% if ${key} %}\n${body}\n{% endif %}`, { start, end });
  };

  const insertImage = (url: string, alt: string) => {
    const attribute = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const tag =
      format === "mjml"
        ? `<mj-image src="${attribute(url)}" alt="${attribute(alt)}" />`
        : `<img src="${attribute(url)}" alt="${attribute(alt)}" style="max-width:100%;height:auto" />`;
    insertSourceText(tag);
  };

  const importSourceFile = async (file: File | undefined) => {
    if (!file) return;
    const extension = file.name.toLowerCase().split(".").at(-1);
    const incomingFormat: CodeFormat | null =
      extension === "mjml"
        ? "mjml"
        : extension === "html" || extension === "htm"
          ? "html"
          : null;
    if (!incomingFormat) {
      setError("Choose an .html, .htm, or .mjml file.");
      return;
    }
    if (file.size > 200 * 1024) {
      setError("Source files must be 200 KB or smaller.");
      return;
    }
    try {
      const source = await file.text();
      if (!source.trim()) {
        setError("The selected source file is empty.");
        return;
      }
      setPendingImport({ name: file.name, format: incomingFormat, source });
      setError(null);
    } catch {
      setError("The selected source file could not be read.");
    }
  };

  const downloadSource = () => {
    const source = activeSource;
    if (!source.trim()) return;
    const objectURL = URL.createObjectURL(
      new Blob([source], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = objectURL;
    link.download = `${templateSlugFromName(name || "template")}.${format}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  };

  // Editable regions are parsed server-side from the authoritative saved
  // source (MJML first for legacy dual-source records). The region action
  // jumps to that source and
  // selects the region so its default content can be edited in place.
  const regionFormat = regionSourceFormat({
    body_html: savedDraft.bodyHtml,
    body_mjml: savedDraft.bodyMjml,
  });
  const savedRegionSource =
    regionFormat === "html" ? savedDraft.bodyHtml : savedDraft.bodyMjml;
  const draftRegionSource = regionFormat === "html" ? bodyHtml : bodyMjml;

  const openSourceEditor = () => {
    setRegionNotice(null);
    setSurface("code");
    setFormat(regionFormat);
    setPendingSelection({ start: 0, end: 0 });
  };

  const openRegion = (region: CampaignTemplateRegion, ordinal: number) => {
    const range = locateRegionInSource(
      draftRegionSource,
      savedRegionSource,
      region,
      ordinal,
    );
    setSurface("code");
    setFormat(regionFormat);
    if (!range) {
      setPendingSelection(null);
      setRegionNotice(
        `Region "${region.name}" is no longer in your ${regionFormat.toUpperCase()} source. Save your changes to refresh the saved regions.`,
      );
      return;
    }
    setRegionNotice(null);
    setPendingSelection(range);
  };

  useEffect(() => {
    if (!pendingSelection || surface !== "code") return;
    const textarea = sourceRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
    // Bring the selection into view: approximate the line's offset from the
    // share of source lines above it.
    const value = textarea.value;
    const totalLines = Math.max(1, value.split("\n").length);
    const lineIndex = value.slice(0, pendingSelection.start).split("\n").length;
    textarea.scrollTop = Math.max(
      0,
      ((lineIndex - 1) / totalLines) * textarea.scrollHeight -
        textarea.clientHeight / 3,
    );
    setPendingSelection(null);
  }, [pendingSelection, surface, format]);

  // Server markup cannot read the actor-scoped recovery record. Do not expose
  // editable controls until hydration has checked it: typing into SSR inputs
  // before React attaches handlers otherwise vanishes on hydration, and a
  // recoverable draft could be overwritten before its prompt appears.
  if (!recoveryChecked) {
    return (
      <div className="mx-auto grid min-h-[320px] max-w-[1500px] place-items-center p-6 text-sm text-muted-foreground" role="status">
        Preparing your template draft…
      </div>
    );
  }

  return (
    <div className="mx-auto min-w-0 max-w-[1500px] space-y-6 p-4 sm:p-6 lg:p-8">
      <Button asChild variant="ghost" className="-ml-3">
        <Link
          href={
            template
              ? asRoute(`/app/templates/${template.id}`)
              : asRoute("/app/templates")
          }
        >
          <ArrowLeft className="h-4 w-4" />
          {template ? template.name : "Templates"}
        </Link>
      </Button>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {intent === "edit" ? "Edit template" : "Create template"}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Build with blocks, or import HTML/MJML if you already have a design.
            Saving adds it to your workspace library; nothing is sent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContentTestSendDialog
            content={() => ({
              subject: subject.trim(),
              body_html: testableHTML,
              body_mjml: bodyMjml.trim() || undefined,
            })}
            trigger={
              <Button
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={!subject.trim() || !testableHTML.trim()}
              >
                Send draft test
              </Button>
            }
          />
          {intent === "edit" &&
          template &&
          campaignTemplateCapabilities(template).can_adapt ? (
            <>
              <Button
                ref={adaptTriggerRef}
                type="button"
                variant="outline"
                className="min-h-11 sm:min-h-9"
                disabled={draftChanged || saving || compilingForSave || generationAvailability !== "available"}
                onClick={() => {
                  setAdaptActivated(true);
                  setAdaptOpen(true);
                }}
                title={
                  draftChanged
                    ? "Save this template before asking AI to change it"
                    : generationAvailability === "error"
                      ? "AI availability could not be checked. Try again shortly."
                      : generationAvailability !== "available"
                        ? "AI-assisted changes are coming soon to this workspace"
                      : "Describe a change, review it, and save a new template"
                }
              >
                <Sparkles className="h-4 w-4" aria-hidden />
                {generationAvailability === "available" ? "Describe a change" : generationAvailability === "error" ? "AI temporarily unavailable" : "AI changes · Coming soon"}
              </Button>
              {adaptActivated ? (
                <AdaptTemplateDialog
                  template={template}
                  open={adaptOpen}
                  onOpenChange={setAdaptOpen}
                  showTrigger={false}
                  editorSource
                  onCloseAutoFocus={() => adaptTriggerRef.current?.focus()}
                />
              ) : null}
            </>
          ) : null}
          {surface === "code" ? (
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              loading={saving || compilingForSave}
              disabled={missingConcurrencyToken || compilingForSave}
              onClick={() => void saveFromSurface()}
            >
              {saving || compilingForSave
                ? "Saving…"
                : intent === "edit"
                  ? "Save changes"
                  : "Create template"}
            </Button>
          ) : null}
        </div>
      </header>

      {intent === "edit" && template && draftChanged ? (
        <p className="text-xs text-muted-foreground">
          Save changes before using AI. It starts from the last saved version,
          not unsaved editor text.
        </p>
      ) : null}

      {recoverableDraft ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              An unsaved draft from this browser is available for this template
              version.
            </span>
            <span className="flex gap-2">
              <Button type="button" size="sm" onClick={restoreDraft}>
                Restore draft
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const storage = browserTemplateRecoveryStorage();
                  if (recoveryKey && storage)
                    clearTemplateRecovery(storage, recoveryKey);
                  setRecoverableDraft(null);
                }}
              >
                Discard draft
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {recoveryProblem ? (
        <Alert variant="warning">
          <AlertDescription>
            Browser recovery could not save this draft. Download your source
            before leaving this page.
          </AlertDescription>
        </Alert>
      ) : null}

      {missingConcurrencyToken ? (
        <Alert>
          <AlertDescription>
            A fresh version token is unavailable, so saving is disabled to
            protect this template from accidental overwrites. Reload this page
            to continue.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5 sm:col-span-1">
          <Label htmlFor="template-name">Name</Label>
          <Input
            id="template-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Weekly product digest"
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-1">
          <Label htmlFor="template-subject">Subject</Label>
          <Input
            id="template-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="This week at {{ company }}"
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-1">
          <Label htmlFor="template-goal">Goal</Label>
          <Select
            id="template-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
          >
            {GOALS.map((value) => (
              <option key={value} value={value}>
                {value.charAt(0).toUpperCase() + value.slice(1)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <details className="rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Template details and personalization
          <span className="ml-2 font-normal text-muted-foreground">Optional preview text, library labels, and merge fields</span>
        </summary>
        <div className="mt-4 space-y-4 border-t pt-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="template-preheader">Preview text</Label>
          <Input
            id="template-preheader"
            value={previewText}
            maxLength={500}
            onChange={(event) => setPreviewText(event.target.value)}
            placeholder="A useful first line for the inbox preview"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="template-category">Category</Label>
          <Input
            id="template-category"
            value={category}
            maxLength={100}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="Product updates"
          />
        </div>
        <div className="grid gap-1.5 sm:col-span-3">
          <Label htmlFor="template-description">Library description</Label>
          <Input
            id="template-description"
            value={description}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="When your team should use this design"
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="template-tags">Tags</Label>
        <Input
          id="template-tags"
          value={tagsInput}
          onChange={(event) => setTagsInput(event.target.value)}
          placeholder="spring-sale, promo, holiday"
        />
        <p className="text-xs text-muted-foreground">
          Comma-separated labels to organize and filter your templates.
        </p>
      </div>

      <TemplateVariablesEditor
        variables={variables}
        onChange={setVariables}
        disabled={saving || missingConcurrencyToken}
      />
        </div>
      </details>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Authoring surface"
          className="inline-flex flex-wrap rounded-md border bg-muted/50 p-1"
        >
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-8"
            variant={surface === "design" ? "secondary" : "ghost"}
            aria-pressed={surface === "design"}
            onClick={() => {
              if (!bodyMjml.trim() && bodyHtml.trim()) return;
              setSurface("design");
            }}
            disabled={!bodyMjml.trim() && Boolean(bodyHtml.trim())}
          >
            Design (blocks)
          </Button>
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-8"
            variant={surface === "code" ? "secondary" : "ghost"}
            aria-pressed={surface === "code"}
            onClick={() => setSurface("code")}
          >
            Code / import
          </Button>
        </div>
        {surface === "code" ? (
          <div
            role="group"
            aria-label="Source format"
            className="inline-flex rounded-md border bg-muted/50 p-1"
          >
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-8"
              variant={format === "html" ? "secondary" : "ghost"}
              aria-pressed={format === "html"}
              onClick={() => setFormat("html")}
            >
              HTML
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-8"
              variant={format === "mjml" ? "secondary" : "ghost"}
              aria-pressed={format === "mjml"}
              onClick={() => setFormat("mjml")}
            >
              MJML
            </Button>
          </div>
        ) : null}
      </div>

      {!bodyMjml.trim() && bodyHtml.trim() ? (
        <div className="space-y-1">
        <ConfirmDialog
          trigger={
            <Button type="button" variant="outline" className="min-h-11" loading={creatingBlockCopy} disabled={intent === "create" || draftChanged || creatingBlockCopy}>
              Make an editable block copy
            </Button>
          }
          title="Create a separate block design?"
          description="Your imported HTML stays unchanged. A new template opens with an empty block canvas and copies the name, subject, and library details. HTML cannot be converted into editable blocks without losing parts of the original."
          confirmLabel="Create block copy"
          onConfirm={() => void createBlockCopy()}
        />
        {intent === "create" || draftChanged ? <p className="text-xs text-muted-foreground">Save this HTML version first, then reopen it to make a separate block copy.</p> : null}
        </div>
      ) : null}

      {surface === "design" ? (
        <div className="min-h-[640px] overflow-hidden rounded-lg border">
          {workspaceBlockError ? (
            <p role="alert" className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-900">
              Workspace blocks are unavailable: {workspaceBlockError}. Built-in blocks still work.
            </p>
          ) : null}
          <EditorShell
            documentId={documentId}
            allowedModes={TEMPLATE_DESIGN_MODES}
            workspaceBlocks={editorWorkspaceBlocks}
            initialMjml={bodyMjml}
            initialHtml={
              mjmlPreview?.source === bodyMjml &&
              mjmlPreview.warnings.length === 0
                ? mjmlPreview.html
                : bodyHtml
            }
            onMjmlSourceChange={(mjml) => {
              setBodyMjml(mjml);
              setBodyHtml("");
              setMjmlPreview(null);
            }}
            onMjmlChange={(mjml, html) => {
              setBodyMjml(mjml);
              setBodyHtml("");
              setMjmlPreview({ source: mjml, html, warnings: [] });
            }}
            onSaveMjml={(mjml) => persist({ body_mjml: mjml, body_html: "" })}
            saving={saving}
          />
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="template-source">
                {format === "html" ? "HTML source" : "MJML source"}
              </Label>
              <div className="flex flex-wrap gap-2">
                <input
                  ref={sourceFileRef}
                  type="file"
                  accept=".html,.htm,.mjml"
                  className="sr-only"
                  aria-label="Import HTML or MJML file"
                  onChange={(event) => {
                    void importSourceFile(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => sourceFileRef.current?.click()}
                >
                  Import file
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    Boolean(format === "html" && bodyMjml.trim()) ||
                    !activeSource.trim()
                  }
                  onClick={downloadSource}
                >
                  Download source
                </Button>
              </div>
            </div>
            <ConfirmDialog
              open={pendingImport !== null}
              onOpenChange={(open) => {
                if (!open) setPendingImport(null);
              }}
              returnFocusRef={sourceRef}
              title="Replace template source?"
              description={`Importing ${pendingImport?.name ?? "this file"} will replace the current source in the editor. Save or download a copy first if you need it.`}
              confirmLabel="Replace source"
              onConfirm={() => {
                if (!pendingImport) return;
                setFormat(pendingImport.format);
                setBodyHtml(
                  pendingImport.format === "html" ? pendingImport.source : "",
                );
                setBodyMjml(
                  pendingImport.format === "mjml" ? pendingImport.source : "",
                );
                setMjmlPreview(null);
                setPendingImport(null);
              }}
            />
            {format === "html" && bodyMjml.trim() ? (
              <Alert>
                <AlertDescription className="space-y-2">
                  <p>
                    This design uses MJML. Convert its current render before
                    editing HTML. Your previous MJML version remains in version history.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      mjmlPreview?.source !== bodyMjml || !mjmlPreview.html ||
                      intent === "create" || draftChanged
                    }
                    onClick={() => {
                      if (intent === "create" || draftChanged || !mjmlPreview || mjmlPreview.source !== bodyMjml)
                        return;
                      setBodyHtml(mjmlPreview.html);
                      setBodyMjml("");
                      setMjmlPreview(null);
                    }}
                  >
                    Use rendered HTML as source
                  </Button>
                  {intent === "create" || draftChanged ? <p className="text-xs text-muted-foreground">Save the current MJML version first, then reopen the template before converting.</p> : null}
                </AlertDescription>
              </Alert>
            ) : null}
            <Textarea
              ref={sourceRef}
              id="template-source"
              value={format === "html" ? bodyHtml : bodyMjml}
              disabled={format === "html" && Boolean(bodyMjml.trim())}
              onChange={(event) => {
                if (format === "html") {
                  setBodyHtml(event.target.value);
                  setBodyMjml("");
                } else {
                  setBodyMjml(event.target.value);
                  setBodyHtml("");
                }
              }}
              spellCheck={false}
              rows={22}
              className="font-mono text-xs"
              placeholder={
                format === "html"
                  ? "<html>…</html> — paste exported HTML or write your own."
                  : "<mjml>…</mjml> — paste exported MJML."
              }
            />
            <p className="text-xs text-muted-foreground" role="status">
              {sourceLineCount} {sourceLineCount === 1 ? "line" : "lines"} ·{" "}
              {activeSource.length.toLocaleString("en-US")} characters
            </p>
            {variables.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5" aria-label="Insert merge variable">
                  {variables.filter((variable) => variable.name.trim()).map((variable) => (
                    <Button key={variable.name} type="button" size="sm" variant="outline"
                      disabled={format === "html" && Boolean(bodyMjml.trim())}
                      onClick={() => insertSourceText(`{{ ${variable.name} }}`)}>
                      {`{{ ${variable.name} }}`}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-1.5" aria-label="Conditional content">
                  <span className="text-xs text-muted-foreground">Show selected content when:</span>
                  {variables.filter((variable) => /^[A-Za-z0-9_.-]+$/.test(variable.name)).map((variable) => (
                    <Button key={variable.name} type="button" size="sm" variant="outline"
                      disabled={format === "html" && Boolean(bodyMjml.trim())}
                      onClick={() => wrapSelectionInCondition(variable.name)}>
                      {variable.name} is set
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Conditions are truthy checks only. Preview both “Missing values” and “Conditions on” before sending.</p>
              </div>
            ) : null}
            {recoveryScope?.tenantId || template?.tenant_id ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={format === "html" && Boolean(bodyMjml.trim())}
                    onClick={() => setAssetPickerOpen(true)}
                  >
                    Insert library image
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={format === "html" && Boolean(bodyMjml.trim())}
                    onClick={() => {
                      const textarea = sourceRef.current;
                      snippetInsertionRef.current = textarea
                        ? {
                            start: textarea.selectionStart,
                            end: textarea.selectionEnd,
                            source: activeSource,
                            format,
                          }
                        : null;
                      setSelectedSnippetSource(
                        textarea
                          ? activeSource.slice(textarea.selectionStart, textarea.selectionEnd)
                          : "",
                      );
                      setSavedBlockPickerOpen(true);
                    }}
                  >
                    Workspace blocks
                  </Button>
                </div>
                <TemplateAssetPicker
                  tenantId={(recoveryScope?.tenantId || template?.tenant_id)!}
                  open={assetPickerOpen}
                  onOpenChange={setAssetPickerOpen}
                  onInsert={insertImage}
                />
                {savedBlockPickerOpen ? (
                  <TemplateSavedBlockPicker
                    tenantId={(recoveryScope?.tenantId || template?.tenant_id)!}
                    format={format}
                    selectedSource={selectedSnippetSource}
                    open={savedBlockPickerOpen}
                    onOpenChange={setSavedBlockPickerOpen}
                    onInsert={(source, block) => {
                      const selection = snippetInsertionRef.current;
                      if (!selection || selection.source !== activeSource || selection.format !== format) {
                        toast.error("The source changed. Reopen Workspace blocks at the insertion point.");
                        return;
                      }
                      const canLink = source.length <= 8192 &&
                        linkedBlocks.length < 20 &&
                        !linkedBlocks.some((link) => link.id === block.id && link.format === format) &&
                        !activeSource.includes(source);
                      insertSourceText(source, selection);
                      if (canLink) {
                        setLinkedBlocks((current) => [...current, {
                          id: block.id, name: block.name, format,
                          version: block.version, source,
                        }]);
                        setLatestBlocks((current) => ({ ...current, [block.id]: block }));
                      } else {
                        toast.message("Inserted as an independent copy; this snippet cannot be linked unambiguously.");
                      }
                      snippetInsertionRef.current = null;
                    }}
                  />
                ) : null}
                {linkedBlocks.filter((link) => link.format === format).length ? (
                  <div className="space-y-2 rounded-lg border bg-muted/20 p-3" aria-label="Linked workspace blocks">
                    <p className="text-sm font-medium">Linked blocks · update review</p>
                    {linkedBlocks.filter((link) => link.format === format).map((link) => {
                      const latest = latestBlocks[link.id];
                      const occurrences = linkedBlockOccurrenceCount(activeSource, link.source);
                      const update = latest ? applyLinkedBlockUpdate(activeSource, link, latest) : null;
                      const state = latest === undefined ? "Checking library…"
                        : latest === null ? "Library block unavailable; pinned content remains"
                        : occurrences !== 1 ? "Source customized or ambiguous; update manually"
                        : latest.version > link.version ? `Version ${latest.version} available; review before applying`
                        : `Current at version ${link.version}`;
                      return (
                        <div key={`${link.id}:${link.format}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-2 text-xs">
                          <div><p className="font-medium">{link.name} · pinned v{link.version}</p><p className="text-muted-foreground">{state}</p></div>
                          <div className="flex gap-2">
                            {update ? <Button type="button" size="sm" variant="outline" onClick={() => {
                              if (format === "html") setBodyHtml(update.body); else setBodyMjml(update.body);
                              setLinkedBlocks((current) => current.map((item) => item === link ? update.link : item));
                            }}>Apply reviewed update</Button> : null}
                            <Button type="button" size="sm" variant="ghost" onClick={() =>
                              setLinkedBlocks((current) => current.filter((item) => item !== link))
                            }>Unlink</Button>
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-xs text-muted-foreground">Linked blocks are pinned; library changes never alter a sent template or overwrite customized content automatically.</p>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Live preview</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!previewableHTML.trim()}
                onClick={() =>
                  setClientPreview({
                    format,
                    source: activeSource,
                    html: previewableHTML,
                  })
                }
              >
                Check client simulations
              </Button>
            </div>
            {format === "html" ? (
              <TemplatePreviewWithVars
                html={
                  (bodyMjml.trim()
                    ? mjmlPreview?.source === bodyMjml && mjmlPreview.warnings.length === 0
                      ? mjmlPreview.html
                      : ""
                    : bodyHtml) ||
                  (bodyMjml.trim()
                    ? '<p style="padding:24px;color:#888">Waiting for a clean current MJML render.</p>'
                    : '<p style="padding:24px;color:#888">Preview appears as you type.</p>')
                }
                source={bodyMjml.trim() ? bodyMjml : undefined}
                title={bodyMjml.trim() ? "Current MJML render" : "Template source preview"}
                variables={serializeTemplateVariableDrafts(variables)}
                compact
              />
            ) : mjmlPreview?.source === bodyMjml ? (
              <TemplatePreviewWithVars
                html={mjmlPreview.html}
                source={bodyMjml}
                title="MJML source preview"
                variables={serializeTemplateVariableDrafts(variables)}
                compact
              />
            ) : (
              <div className="flex h-[440px] items-center justify-center rounded-lg border bg-muted/30 px-8 text-center text-sm text-muted-foreground">
                {mjmlPreviewError ?? "Compiling current MJML…"}
              </div>
            )}
            {format === "mjml" &&
            mjmlPreview?.source === bodyMjml &&
            mjmlPreview.warnings.length > 0 ? (
              <Alert variant="warning">
                <AlertDescription>
                  {mjmlPreview.warnings.join(" ")}
                </AlertDescription>
              </Alert>
            ) : null}
            <p className="text-xs text-muted-foreground">
              For privacy, this editor preview does not load remote images.
              Check images with a test send before publishing.
            </p>
            {clientPreviewCurrent && clientPreview ? (
              <div className="max-h-[700px] overflow-auto rounded-lg border">
                <CrossClientPreview html={clientPreview.html}
                  baselineHtml={template?.body_html || undefined}
                  baselineMjml={template?.body_mjml || undefined} />
              </div>
            ) : null}
          </div>
        </div>
      )}

      <TemplatePreflightCard
        source={bodyMjml.trim() || bodyHtml}
        context={{ subject, previewText, compiledHtml: previewableHTML || null }}
      />

      {regionNotice ? (
        <Alert>
          <AlertDescription>{regionNotice}</AlertDescription>
        </Alert>
      ) : null}

      {intent === "edit" && template ? (
        <TemplateRegionsPanel
          templateId={template.id}
          etag={template.etag}
          sourceLabel={regionFormat === "html" ? "HTML" : "MJML"}
          draftDiverged={draftRegionSource !== savedRegionSource}
          onOpenRegion={openRegion}
          onOpenEditor={openSourceEditor}
        />
      ) : null}
    </div>
  );
}
