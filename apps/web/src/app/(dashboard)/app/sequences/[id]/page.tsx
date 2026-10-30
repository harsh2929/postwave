// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Copy,
  FileDown,
  LayoutTemplate,
  Save,
  Send,
  Sparkles,
  Wand2,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { ApiError, apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";
import { STALE, qk } from "@/lib/query-keys";
import {
  type Sequence,
  type SequenceEmail,
  type StyleControls,
} from "@/lib/voice-types";
import { sequenceToMarkdown } from "@/lib/sequence-helpers";
import { downloadTextFile } from "@/lib/download";
import { copyToClipboard } from "@/lib/clipboard";
import { newUUIDv7 } from "@/lib/http-fetch";
import { asRoute } from "@/lib/typed-routes";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  SEQUENCE_REGENERATION_AVAILABLE,
  canEditSequenceDraft,
  sequenceEditUnavailableReason,
  sequenceStatusPresentation,
} from "@/lib/sequence-operational-availability";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Tooltip } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { CanvasEditOutcome } from "@/components/sequence/StepCanvas";
import {
  canvasStepsOf,
  classifySaveFailure,
  commitCanvasEdit,
  countSteps,
  emailPositionNear,
  findBlockingStep,
  followEmailPosition,
  reconcileSelectedPosition,
  setEmailVariants,
  type CanvasEdit,
  type SaveFailure,
} from "@/lib/flow-canvas-model";
import type { SequenceEmailVariant } from "@/lib/voice-types";
import { cn } from "@/lib/utils";

import { SequenceAvailabilityNotice } from "./sequence-availability-notice";

// The voice API client is shared with the sequence list and template routes
// but only runs from the load effect and the save/regenerate handlers here,
// so it is fetched at those call sites rather than in the entry graph.
const voiceApi = () => import("@/lib/voice-api");
// Markdown → HTML runs only when the body editor reports a change or a save,
// so the converter loads at those call sites as well.
const editorMarkdown = () => import("@/components/editor/markdown");
const StepCanvas = dynamic(
  () =>
    import("@/components/sequence/StepCanvas").then(
      (module) => module.StepCanvas,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Loading sequence steps"
        className="space-y-2 p-3"
      >
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    ),
  },
);
const SequenceSettingsCard = dynamic(
  () =>
    import("./sequence-settings-card").then(
      (module) => module.SequenceSettingsCard,
    ),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        className="flex min-h-14 items-center border-b bg-muted/20 px-4 text-xs text-muted-foreground"
      >
        Loading goal &amp; exit criteria…
      </p>
    ),
  },
);
const FidelityChip = dynamic(
  () => import("./sequence-fidelity").then((module) => module.FidelityChip),
  {
    ssr: false,
    loading: () => (
      <span
        className="inline-flex h-5 min-w-8 items-center justify-center rounded bg-muted text-xs text-muted-foreground"
        aria-label="Loading fidelity score"
      >
        —
      </span>
    ),
  },
);
const FidelityBreakdown = dynamic(
  () =>
    import("./sequence-fidelity").then((module) => module.FidelityBreakdown),
  {
    ssr: false,
    loading: () => (
      <div
        className="border-t bg-card px-4 py-3 text-sm text-muted-foreground"
        role="status"
      >
        Loading fidelity details…
      </div>
    ),
  },
);
const ContentTestSendDialog = dynamic(
  () =>
    import("@/components/content-test-send-dialog").then(
      (module) => module.ContentTestSendDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <Button variant="outline" size="sm" type="button" disabled>
        <Send className="h-4 w-4" />
        <span className="hidden sm:inline">Loading test send…</span>
      </Button>
    ),
  },
);
const SequencePerformancePanel = dynamic(
  () =>
    import("./sequence-performance-panel").then(
      (module) => module.SequencePerformancePanel,
    ),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        className="border-b bg-muted/20 px-4 py-3 text-xs text-muted-foreground"
      >
        Loading send performance…
      </p>
    ),
  },
);
const SequenceAbVariantsDialog = dynamic(
  () =>
    import("./sequence-ab-variants-dialog").then(
      (module) => module.SequenceAbVariantsDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span role="status" className="sr-only">
        Loading A/B variant editor…
      </span>
    ),
  },
);
const RegenerateEmailDialog = dynamic(
  () =>
    import("./regenerate-email-dialog").then(
      (module) => module.RegenerateEmailDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span role="status" className="sr-only">
        Loading regeneration review…
      </span>
    ),
  },
);
// The recovery banner renders nothing until a save fails, so its module loads
// the first time there is a failure to show.
const AutosaveRecoveryBanner = dynamic(
  () =>
    import("@/components/sequence/AutosaveRecoveryBanner").then(
      (module) => module.AutosaveRecoveryBanner,
    ),
  { ssr: false, loading: () => null },
);
// Presence, copy-link and last-viewed are shared header tools whose realtime
// and activity clients outweigh the header itself; they mount once loaded.
const SequenceDetailHeaderTools = dynamic(
  () =>
    import("./sequence-detail-header-tools").then(
      (module) => module.SequenceDetailHeaderTools,
    ),
  { ssr: false, loading: () => null },
);
// The selected email step's controls and body editor, moved out verbatim; the
// editor inside stays its own deferred boundary.
const EmailStepSection = dynamic(
  () =>
    import("./email-step-section").then((module) => module.EmailStepSection),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Loading email step"
        className="flex-1 space-y-3 p-4"
      >
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="min-h-72 w-full" />
      </div>
    ),
  },
);
const SequenceNoEmailView = dynamic(
  () =>
    import("./sequence-no-email-view").then(
      (module) => module.SequenceNoEmailView,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-label="Loading sequence"
        className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8"
      >
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    ),
  },
);

const SEQUENCE_EDIT_READ_ONLY_MESSAGE =
  "Editing sequences is read-only for this session. Owner, admin, or editor access outside viewer mode is required to change a draft's copy, structure, or delays.";

const DEFAULT_REGENERATION_STYLE: StyleControls = {
  humor: 0,
  directness: 0,
  lengthBias: 0,
  formality: 0,
};

interface RegenerationTarget {
  sequenceId: string;
  version: number;
  email: SequenceEmail;
}

interface RegenerationIntent {
  signature: string;
  idempotencyKey: string;
}

export default function SequenceDetailPage() {
  const params = useParams<{ id: string }>();
  const [seq, setSeq] = useState<Sequence | null>(null);
  const seqRef = useRef<Sequence | null>(null);
  seqRef.current = seq;
  const [error, setError] = useState<string | null>(null);
  const [selectedPosition, setSelectedPosition] = useState(1);
  const [saving, setSaving] = useState(false);
  // The goal/stuck settings card PATCHes under the same If-Match version as
  // the email save; neither may run while the other is in flight.
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  // Tracks local edits so the page can show "Unsaved changes" before users
  // navigate away. Cleared on load and on save.
  const [dirty, setDirty] = useState(false);
  const [abOpen, setAbOpen] = useState(false);
  const abTriggerRef = useRef<HTMLButtonElement>(null);
  // automation-71: the last failed draft save, classified by its remedy
  // (retry the same snapshot, or discard it and reload on a 412 conflict).
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const [reloading, setReloading] = useState(false);
  // A canvas edit that turns a legacy emails-only row into a step graph waits
  // here for the operator to accept losing the per-email fidelity metadata.
  const [graphConfirm, setGraphConfirm] = useState<{
    sequence: Sequence;
    selected: number | null;
  } | null>(null);
  // The body editor is seeded only when it mounts. Structural edits and
  // reloads can put different copy at the same position, so they bump this to
  // remount it on what the draft now holds.
  const [editorRevision, setEditorRevision] = useState(0);
  const [subjectSuggestions, setSubjectSuggestions] = useState<string[] | null>(
    null,
  );
  const [suggesting, setSuggesting] = useState(false);
  const [regenerationOpen, setRegenerationOpen] = useState(false);
  const [regenerationTarget, setRegenerationTarget] =
    useState<RegenerationTarget | null>(null);
  const [regenerationCandidate, setRegenerationCandidate] =
    useState<SequenceEmail | null>(null);
  const [regenerationHint, setRegenerationHint] = useState("");
  const [regenerationStyle, setRegenerationStyle] = useState<StyleControls>(
    DEFAULT_REGENERATION_STYLE,
  );
  const [regenerationPhase, setRegenerationPhase] = useState<
    "idle" | "generating" | "accepting"
  >("idle");
  const [regenerationError, setRegenerationError] = useState<string | null>(
    null,
  );
  const regenerationAbortRef = useRef<AbortController | null>(null);
  const regenerationOperationRef = useRef<"generating" | "accepting" | null>(
    null,
  );
  const regenerationIntentRef = useRef<RegenerationIntent | null>(null);
  const regenerationTriggerRef = useRef<HTMLButtonElement>(null);
  // Set by the loaded render so the global ⌘S handler can trigger a save
  // without re-subscribing on every keystroke.
  const saveRef = useRef<(() => void) | null>(null);

  // Draft lifecycle (status + confirmed version) is only half the edit gate:
  // without the effective role a viewer-mode session gets a fully live editor
  // whose Save the server rejects only after the copy has been rewritten. Read
  // the same server-resolved identity SequenceSettingsCard below already reads.
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });

  // Guard header/subject/delay/body edits against tab-close + in-app nav
  // (SEQ-021). `dirty` is only ever set while editing a confirmed draft.
  useUnsavedChangesGuard(dirty);

  // ⌘S / Ctrl-S saves (SEQ-024).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(
    () => () => {
      regenerationAbortRef.current?.abort();
    },
    [],
  );

  // Auto-dismiss the transient "Saved" confirmation (SEQ-025).
  useEffect(() => {
    if (saveNotice !== "Saved") return;
    const t = setTimeout(() => setSaveNotice(null), 2500);
    return () => clearTimeout(t);
  }, [saveNotice]);

  useEffect(() => {
    let current = true;
    setError(null);
    void voiceApi()
      .then(({ getSequence }) => getSequence(params.id))
      .then((loaded) => {
        if (!current) return;
        setSeq(loaded);
        setDirty(false);
      })
      .catch((err: unknown) => {
        if (!current) return;
        setError(
          err instanceof Error ? err.message : "Could not load sequence",
        );
      });
    return () => {
      current = false;
    };
  }, [params.id]);

  if (error) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-2 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <h1 className="text-xl font-semibold">Couldn&apos;t load sequence</h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {error}
        </p>
        <Button asChild variant="link" className="mt-2 px-0">
          <Link href="/app/sequences">← Back to sequences</Link>
        </Button>
      </div>
    );
  }

  if (!seq || seq.id !== params.id) {
    // Skeleton shell matching the editor layout, consistent with the flow
    // editor's loading branch.
    return (
      <div
        className="flex h-[calc(100dvh-3.5rem)] flex-col"
        aria-busy="true"
        aria-label="Loading sequence"
      >
        <div className="border-b bg-card px-3 py-3 sm:px-6 flex flex-wrap items-center gap-3">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-9 w-full sm:max-w-md" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 min-h-0">
          <aside className="border-b bg-card p-2 space-y-2 lg:col-span-3 lg:border-b-0 lg:border-r xl:col-span-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </aside>
          <section className="flex flex-col min-w-0 min-h-0 p-4 space-y-4 lg:col-span-9 xl:col-span-10">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="flex-1 w-full" />
          </section>
        </div>
      </div>
    );
  }

  const statusPresentation = sequenceStatusPresentation(seq.status);
  // A failed or still-pending identity read is not proof of a missing role, so
  // each gets its own sentence rather than the read-only one.
  // `isError` alone is NOT loss of authority. TanStack v5 keeps `data` when a
  // BACKGROUND refetch fails, and this app refetches identity on window focus
  // (query-client.ts), so one blip on tab-refocus would otherwise demote a
  // legitimate editor mid-session — locking the name, body, Save and ⌘S while
  // `useUnsavedChangesGuard` still holds their edits, and telling them to
  // reload, which discards those edits. Only an error with NO usable identity
  // is unverified. The sibling this mirrors, sequence-settings-card.tsx:111,
  // already writes off the last known-good identity.
  const identityUnverified = meQuery.isError && !meQuery.data;
  const writeUnavailableReason = meQuery.isPending
    ? "Checking your write access…"
    : identityUnverified
      ? "Your access for this workspace could not be confirmed, so editing is locked. Reload the page to try again."
      : canWriteCampaigns(meQuery.data)
        ? null
        : SEQUENCE_EDIT_READ_ONLY_MESSAGE;
  const canEdit =
    writeUnavailableReason === null &&
    canEditSequenceDraft(seq.status, seq.version);
  const editUnavailableReason =
    writeUnavailableReason ??
    sequenceEditUnavailableReason(seq.status, seq.version);
  const selected =
    seq.emails.find((e) => e.position === selectedPosition) ?? seq.emails[0];

  const onSave = async (snapshot: Sequence = seq) => {
    if (writeUnavailableReason !== null) {
      setSaveNotice(writeUnavailableReason);
      return;
    }
    if (!canEditSequenceDraft(snapshot.status, snapshot.version)) {
      setSaveNotice(
        sequenceEditUnavailableReason(snapshot.status, snapshot.version),
      );
      return;
    }
    setSaving(true);
    setSaveNotice(null);
    try {
      const { updateSequence } = await voiceApi();
      const saved = await updateSequence(snapshot);
      if (seqRef.current === snapshot) {
        setSeq(saved);
        setDirty(false);
      } else if (saved.version) {
        // Newer local edits landed while this save was in flight. They are
        // still unsaved, but they now sit on the confirmed revision — adopt it
        // or the next save carries a stale If-Match and earns a 412.
        const version = saved.version;
        setSeq((curr) =>
          curr && curr.id === saved.id ? { ...curr, version } : curr,
        );
      }
      setSaveFailure(null);
      setSaveNotice("Saved");
    } catch (err) {
      // The local snapshot is kept; the recovery banner offers the remedy the
      // failure calls for and renders the server's own sentence.
      setSaveFailure(classifySaveFailure(err));
    } finally {
      setSaving(false);
    }
  };

  // ── Canvas (automation-63/64/65/67) ────────────────────────────────────
  // The canvas edits the whole step tree. Every verb lands in the local draft
  // and, when the draft is complete, saves at once through the same
  // version-protected PATCH as the Save button (desktop autosaves the same
  // way). An incomplete step stays local — flagged on the canvas — because
  // the server validates the whole tree and would 400 the entire write.
  const workingSteps = canvasStepsOf(seq);
  const canvasBusy =
    saving || settingsSaving || reloading || regenerationPhase === "accepting";
  const canvasLockedReason = !canEdit
    ? editUnavailableReason
    : "Wait for the current save to finish before changing the structure.";
  const canvasHold = dirty
    ? (findBlockingStep(workingSteps)?.message ?? null)
    : null;

  const landCanvasCommit = (next: Sequence, nextSelected: number | null) => {
    seqRef.current = next;
    setSeq(next);
    setDirty(true);
    setEditorRevision((revision) => revision + 1);
    if (nextSelected !== null) setSelectedPosition(nextSelected);
    if (findBlockingStep(canvasStepsOf(next))) return;
    void onSave(next);
  };

  const applyCanvasEdit = (edit: CanvasEdit): CanvasEditOutcome => {
    const current = seqRef.current;
    if (!current || !canEdit || canvasBusy) return "refused";
    const previous = canvasStepsOf(current);
    const commit = commitCanvasEdit(current, previous, edit);
    const focusIndex =
      edit.focus && edit.focus.slice.length === 0 ? edit.focus.index : null;
    const created =
      focusIndex !== null && edit.origin[focusIndex] === null
        ? edit.steps[focusIndex]
        : undefined;
    const nextSelected =
      created?.type === "email"
        ? created.position
        : ((selected
            ? followEmailPosition(previous, edit, selected.position)
            : null) ?? emailPositionNear(edit.steps, focusIndex ?? 0));
    if (commit.convertsToGraph) {
      setGraphConfirm({ sequence: commit.sequence, selected: nextSelected });
      return "pending";
    }
    landCanvasCommit(commit.sequence, nextSelected);
    return "applied";
  };

  const retryFailedSave = () => {
    const current = seqRef.current;
    if (!current || saving) return;
    void onSave(current);
  };

  // automation-71: discard the unconfirmed local snapshot and load the latest
  // stored draft (GET /api/v1/voice/sequences/{id}). Reached only through the
  // banner's confirm, which names the loss.
  const reloadLatestVersion = async () => {
    const current = seqRef.current;
    if (!current) return;
    setReloading(true);
    try {
      const { getSequence } = await voiceApi();
      const latest = await getSequence(current.id);
      seqRef.current = latest;
      setSeq(latest);
      setDirty(false);
      setSaveFailure(null);
      setSaveNotice(null);
      setEditorRevision((revision) => revision + 1);
      setSelectedPosition((position) =>
        reconcileSelectedPosition(latest, position),
      );
      toast.success("Loaded the latest saved version of this draft.");
    } catch (err) {
      setSaveFailure({
        kind: "reload",
        message: apiErrorMessage(
          err,
          "The latest version could not be loaded. Try again.",
        ),
      });
    } finally {
      setReloading(false);
    }
  };

  const recoveryBanner = (
    <AutosaveRecoveryBanner
      failure={saveFailure}
      busy={saving || reloading}
      canRetry={canEdit}
      retryUnavailableReason={editUnavailableReason}
      onRetry={retryFailedSave}
      onReload={reloadLatestVersion}
    />
  );

  const stepCanvas = (
    <StepCanvas
      steps={workingSteps}
      selectedEmailPosition={selected?.position ?? null}
      canEdit={canEdit}
      busy={canvasBusy}
      lockedReason={canvasLockedReason}
      hold={canvasHold}
      renderEmailMeta={(position) => {
        const email = seq.emails.find((item) => item.position === position);
        return email ? <FidelityChip score={email.fidelity} /> : null;
      }}
      onSelectEmail={setSelectedPosition}
      onEdit={applyCanvasEdit}
    />
  );

  const graphConfirmDialog = (
    <ConfirmDialog
      open={graphConfirm !== null}
      onOpenChange={(open) => {
        if (!open) setGraphConfirm(null);
      }}
      title="Store this draft as a step graph?"
      description="Adding a wait, condition, tag, or exit step — or an A/B test — saves every email in this draft as a step record. Step records have no field for the stored per-email voice-fidelity scores or regeneration counts, so those read 0 after this save. The email copy and delays are kept."
      confirmLabel="Convert and save"
      confirmVariant="default"
      onConfirm={() => {
        const pending = graphConfirm;
        setGraphConfirm(null);
        if (pending) landCanvasCommit(pending.sequence, pending.selected);
      }}
    />
  );

  if (!selected) {
    return (
      <SequenceNoEmailView
        seq={seq}
        canEdit={canEdit}
        statusDetail={statusPresentation.detail}
        editUnavailableReason={editUnavailableReason}
        recoveryBanner={recoveryBanner}
        stepCanvas={stepCanvas}
        graphConfirmDialog={graphConfirmDialog}
      />
    );
  }

  // User-driven email edit (subject/body) - mark the page dirty so unsaved
  // work is surfaced before navigation.
  const onEmailEdit = (next: SequenceEmail) => {
    if (!canEdit) return;
    setDirty(true);
    updateEmail(next);
  };

  const updateEmail = (next: SequenceEmail) => {
    setSeq((curr) =>
      curr
        ? {
            ...curr,
            emails: curr.emails.map((e) =>
              e.position === next.position ? next : e,
            ),
          }
        : curr,
    );
  };

  const onSubjectChange = (subject: string) =>
    onEmailEdit({ ...selected, subject });

  const onMarkdownChange = (bodyMarkdown: string) =>
    editorMarkdown().then(({ markdownToHtml }) =>
      onEmailEdit({
        ...selected,
        bodyMarkdown,
        bodyHtml: markdownToHtml(bodyMarkdown),
      }),
    );

  const onMjmlChange = (bodyMjml: string, bodyHtml: string) =>
    onEmailEdit({ ...selected, bodyMjml, bodyHtml });

  const onMjmlSourceChange = (bodyMjml: string) =>
    onEmailEdit({ ...selected, bodyMjml });

  const onSaveMarkdown = async (md: string) => {
    const { markdownToHtml } = await editorMarkdown();
    const email = {
      ...selected,
      bodyMarkdown: md,
      bodyHtml: markdownToHtml(md),
    };
    const snapshot = {
      ...seq,
      emails: seq.emails.map((item) =>
        item.position === email.position ? email : item,
      ),
    };
    seqRef.current = snapshot;
    setSeq(snapshot);
    setDirty(true);
    await onSave(snapshot);
  };

  const onSaveMjml = async (mjml: string, html: string) => {
    const email = { ...selected, bodyMjml: mjml, bodyHtml: html };
    const snapshot = {
      ...seq,
      emails: seq.emails.map((item) =>
        item.position === email.position ? email : item,
      ),
    };
    seqRef.current = snapshot;
    setSeq(snapshot);
    setDirty(true);
    await onSave(snapshot);
  };

  const onDelayChange = (position: number, delayHours: number) => {
    if (!canEdit) return;
    setDirty(true);
    setSeq((curr) =>
      curr
        ? {
            ...curr,
            emails: curr.emails.map((e) =>
              e.position === position ? { ...e, delayHours } : e,
            ),
          }
        : curr,
    );
  };

  // automation-68: the A/B split lives on the email step itself and saves
  // with the draft like any other canvas edit.
  const selectedStepIndex = workingSteps.findIndex(
    (step) => step.type === "email" && step.position === selected.position,
  );
  const selectedStep =
    selectedStepIndex >= 0 ? workingSteps[selectedStepIndex] : undefined;
  const selectedVariants =
    selectedStep?.type === "email" ? selectedStep.email.variants : undefined;
  const selectedVariantCount = Array.isArray(selectedVariants)
    ? selectedVariants.length
    : 0;
  const saveSelectedVariants = (
    variants: SequenceEmailVariant[] | undefined,
  ) => {
    if (selectedStepIndex < 0) return;
    const edit = setEmailVariants(
      workingSteps,
      { slice: [], index: selectedStepIndex },
      variants,
    );
    if (edit) applyCanvasEdit(edit);
  };

  const suggestSubjects = async () => {
    if (!canEdit) return;
    setSuggesting(true);
    try {
      const { generateSubjectSuggestions } = await voiceApi();
      const variants = await generateSubjectSuggestions(selected.subject);
      setSubjectSuggestions(variants);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not fetch suggestions.",
      );
    } finally {
      setSuggesting(false);
    }
  };

  const exportMarkdown = () => {
    downloadTextFile(
      `${seq.name || "sequence"}.md`,
      sequenceToMarkdown(seq),
      "text/markdown;charset=utf-8",
    );
    toast.success("Markdown downloaded.");
  };

  const copyAll = async () => {
    const result = await copyToClipboard(sequenceToMarkdown(seq));
    if (result === "copied") toast.success("Sequence copied to clipboard.");
    else if (result === "unavailable")
      toast.error("Clipboard isn’t available in this browser.");
    else toast.error("Couldn’t copy to clipboard.");
  };

  const sourceTemplateId = seq.templateId?.trim();
  const canRegenerate =
    SEQUENCE_REGENERATION_AVAILABLE &&
    canEdit &&
    Boolean(sourceTemplateId) &&
    !dirty &&
    !saving &&
    !settingsSaving;
  const regenerationUnavailableReason = !SEQUENCE_REGENERATION_AVAILABLE
    ? "Regeneration previews are not available in this build."
    : !canEdit
      ? editUnavailableReason
      : !sourceTemplateId
        ? "Regeneration previews require a draft with a confirmed source template."
        : dirty
          ? "Save or discard your current edits before generating a preview."
          : saving || settingsSaving
            ? "Wait for the current save to finish before generating a preview."
            : undefined;

  const resetRegeneration = () => {
    regenerationAbortRef.current?.abort();
    regenerationAbortRef.current = null;
    setRegenerationOpen(false);
    setRegenerationTarget(null);
    setRegenerationCandidate(null);
    setRegenerationError(null);
    setRegenerationPhase("idle");
  };

  const openRegeneration = () => {
    if (!canRegenerate || !seq.version || regenerationOperationRef.current) {
      return;
    }
    setRegenerationTarget({
      sequenceId: seq.id,
      version: seq.version,
      email: selected,
    });
    setRegenerationCandidate(null);
    setRegenerationHint("");
    setRegenerationStyle(DEFAULT_REGENERATION_STYLE);
    setRegenerationError(null);
    setRegenerationPhase("idle");
    setRegenerationOpen(true);
  };

  const requestRegenerationPreview = async () => {
    if (
      !regenerationTarget ||
      regenerationPhase !== "idle" ||
      regenerationOperationRef.current
    ) {
      return;
    }
    // Write authority can drop (role change, viewer mode) while this dialog is
    // open. A preview spends generation quota, so re-read the gate here.
    if (writeUnavailableReason !== null) {
      setRegenerationError(writeUnavailableReason);
      return;
    }
    const current = seqRef.current;
    if (
      !current ||
      current.id !== regenerationTarget.sequenceId ||
      current.version !== regenerationTarget.version ||
      !canEditSequenceDraft(current.status, current.version)
    ) {
      setRegenerationError(
        "This draft changed after the dialog opened. Discard this preview and reopen it from the latest draft.",
      );
      return;
    }

    const controller = new AbortController();
    const intentSignature = JSON.stringify({
      sequenceId: regenerationTarget.sequenceId,
      version: regenerationTarget.version,
      position: regenerationTarget.email.position,
      hint: regenerationHint.trim(),
      style: regenerationStyle,
    });
    let intent = regenerationIntentRef.current;
    if (!intent || intent.signature !== intentSignature) {
      intent = {
        signature: intentSignature,
        idempotencyKey: newUUIDv7(),
      };
      regenerationIntentRef.current = intent;
    }
    regenerationAbortRef.current?.abort();
    regenerationAbortRef.current = controller;
    regenerationOperationRef.current = "generating";
    setRegenerationError(null);
    setRegenerationPhase("generating");
    try {
      const { regenerateEmail } = await voiceApi();
      const candidate = await regenerateEmail(
        regenerationTarget.sequenceId,
        regenerationTarget.email.position,
        {
          hint: regenerationHint.trim() || undefined,
          style: regenerationStyle,
        },
        {
          idempotencyKey: intent.idempotencyKey,
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      // A completed preview settles this exact paid intent. Adjusting the
      // prompt or explicitly asking for another candidate must use a new key.
      if (regenerationIntentRef.current === intent) {
        regenerationIntentRef.current = null;
      }
      const latest = seqRef.current;
      if (
        !latest ||
        latest.id !== regenerationTarget.sequenceId ||
        latest.version !== regenerationTarget.version
      ) {
        setRegenerationError(
          "The draft changed while the candidate was generated. Nothing was saved; discard it and reopen regeneration.",
        );
        return;
      }
      setRegenerationCandidate(candidate);
    } catch (err) {
      if (!controller.signal.aborted) {
        setRegenerationError(
          err instanceof Error
            ? err.message
            : "Could not generate a review candidate. Nothing was saved.",
        );
      }
    } finally {
      if (regenerationAbortRef.current === controller) {
        regenerationAbortRef.current = null;
      }
      if (regenerationOperationRef.current === "generating") {
        regenerationOperationRef.current = null;
        setRegenerationPhase("idle");
      }
    }
  };

  const startNewRegenerationAttempt = () => {
    if (regenerationOperationRef.current) return;
    regenerationIntentRef.current = null;
    void requestRegenerationPreview();
  };

  const acceptRegenerationCandidate = async () => {
    if (
      !regenerationTarget ||
      !regenerationCandidate ||
      regenerationPhase !== "idle" ||
      regenerationOperationRef.current
    ) {
      return;
    }
    if (writeUnavailableReason !== null) {
      setRegenerationError(writeUnavailableReason);
      return;
    }
    const current = seqRef.current;
    const currentEmail = current?.emails?.find(
      (email) => email.position === regenerationTarget.email.position,
    );
    if (
      !current ||
      !currentEmail ||
      current.id !== regenerationTarget.sequenceId ||
      current.version !== regenerationTarget.version ||
      !canEditSequenceDraft(current.status, current.version)
    ) {
      setRegenerationError(
        "This draft changed after the candidate was generated. Nothing was saved; discard it and reopen regeneration.",
      );
      return;
    }

    // Regeneration is copy-only. Retain the stable local identity, top-level
    // position, and the author's existing delay instead of silently restoring
    // template scheduling metadata from the generated candidate.
    const acceptedEmail: SequenceEmail = {
      ...regenerationCandidate,
      id: currentEmail.id,
      position: currentEmail.position,
      delayHours: currentEmail.delayHours,
    };
    const snapshot: Sequence = {
      ...current,
      emails: current.emails.map((email) =>
        email.position === acceptedEmail.position ? acceptedEmail : email,
      ),
    };

    setRegenerationError(null);
    regenerationOperationRef.current = "accepting";
    setRegenerationPhase("accepting");
    try {
      // Do not place this explicit acceptance in the offline replay queue. An
      // ambiguous response remains safe: a retry with the old exact version
      // conflicts, after which the latest stored draft is reloaded.
      const { updateSequence } = await voiceApi();
      const saved = await updateSequence(snapshot, { requireOnline: true });
      seqRef.current = saved;
      setSeq(saved);
      setDirty(false);
      setSaveNotice("Saved");
      resetRegeneration();
      toast.success(`Email #${acceptedEmail.position} candidate saved.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        try {
          const { getSequence } = await voiceApi();
          const latest = await getSequence(regenerationTarget.sequenceId);
          seqRef.current = latest;
          setSeq(latest);
          setDirty(false);
          resetRegeneration();
          toast.error(
            "The draft changed elsewhere, so the candidate was not applied. The latest version has been reloaded.",
          );
        } catch {
          setRegenerationError(
            "The draft changed elsewhere, so the candidate was not applied. Reload the page before trying again.",
          );
        }
      } else {
        setRegenerationError(
          err instanceof Error
            ? err.message
            : "Could not save the candidate. The preview has not been accepted.",
        );
      }
    } finally {
      if (regenerationOperationRef.current === "accepting") {
        regenerationOperationRef.current = null;
      }
      setRegenerationPhase("idle");
    }
  };

  // Expose the current save to the global ⌘S handler only when a save is
  // actually meaningful.
  saveRef.current =
    canEdit && dirty && !saving && !settingsSaving ? () => void onSave() : null;

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col lg:h-[calc(100dvh-3.5rem)]">
      <h1 className="sr-only">Edit sequence: {seq.name}</h1>
      <div className="border-b bg-card px-3 py-3 sm:px-6 flex flex-wrap items-center gap-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          aria-label="Back to sequences"
          title="Back to sequences"
        >
          <Link href="/app/sequences">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
        </Button>
        <Input
          value={seq.name}
          aria-label="Sequence name"
          disabled={!canEdit}
          title={canEdit ? "Edit sequence name" : editUnavailableReason}
          onChange={(e) => {
            if (!canEdit) return;
            setDirty(true);
            setSeq({ ...seq, name: e.target.value });
          }}
          className="min-w-0 flex-1 font-medium sm:max-w-md"
        />
        <Badge
          variant={
            statusPresentation.tone === "danger"
              ? "destructive"
              : statusPresentation.tone === "warning"
                ? "warning"
                : seq.status === "archived"
                  ? "outline"
                  : "secondary"
          }
          title={statusPresentation.detail}
        >
          {statusPresentation.label}
        </Badge>
        <span className="text-xs text-muted-foreground hidden md:inline">
          Avg fidelity {seq.fidelityAvg}
        </span>
        {saveNotice ? (
          <span
            className={cn(
              "text-xs",
              saveNotice === "Saved" ? "text-success" : "text-destructive",
            )}
          >
            {saveNotice}
          </span>
        ) : dirty && !saving ? (
          // The only persistence path is Save, so surface pending local edits.
          <span className="text-xs text-warning-emphasis">Unsaved changes</span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {sourceTemplateId ? (
            <Button asChild variant="ghost" size="sm">
              <Link
                href={asRoute(`/app/sequence-templates/${sourceTemplateId}`)}
                aria-label="View source template"
              >
                <LayoutTemplate className="h-4 w-4" />
                <span className="hidden sm:inline">View template</span>
              </Link>
            </Button>
          ) : null}
          {sourceTemplateId ? (
            // SEQ-040: re-run the generator with different variables. Lands on
            // the create flow pre-filled from the per-template session draft.
            <Button asChild variant="ghost" size="sm">
              <Link
                href={asRoute(`/app/sequences/new/${sourceTemplateId}`)}
                aria-label="Re-run sequence generation"
              >
                <Wand2 className="h-4 w-4" />
                <span className="hidden sm:inline">Re-run</span>
              </Link>
            </Button>
          ) : null}
          <SequenceDetailHeaderTools sequenceId={seq.id} />
          <Tooltip
            label="Copy all email copy as markdown"
            className="[&[aria-hidden=true]]:hidden"
          >
            <IconButton
              size="sm"
              aria-label="Copy all email copy"
              onClick={() => void copyAll()}
            >
              <Copy className="h-4 w-4" />
            </IconButton>
          </Tooltip>
          <Tooltip
            label="Download the sequence as a markdown file"
            className="[&[aria-hidden=true]]:hidden"
          >
            <IconButton
              size="sm"
              aria-label="Export sequence as markdown"
              onClick={exportMarkdown}
            >
              <FileDown className="h-4 w-4" />
            </IconButton>
          </Tooltip>
          <Button
            ref={regenerationTriggerRef}
            variant="outline"
            size="sm"
            type="button"
            disabled={!canRegenerate}
            title={
              canRegenerate
                ? "Generate an unsaved review candidate for this email"
                : regenerationUnavailableReason
            }
            aria-label="Regenerate selected email"
            onClick={openRegeneration}
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Regenerate</span>
          </Button>
          {/* SEQ-045: inbox render-check of the selected email (a single
              transactional send to yourself), independent of sequence
              activation which stays gated. */}
          <ContentTestSendDialog
            content={() => ({
              subject: selected.subject ?? "",
              body_html: selected.bodyHtml || undefined,
              body_mjml: selected.bodyMjml || undefined,
              plain_text: selected.bodyMarkdown || undefined,
            })}
            trigger={
              <Button
                variant="outline"
                size="sm"
                type="button"
                aria-label="Send test email"
              >
                <Send className="h-4 w-4" />
                <span className="hidden sm:inline">Send test</span>
              </Button>
            }
          />
          <Button
            size="sm"
            type="button"
            onClick={() => void onSave()}
            disabled={!canEdit || saving || settingsSaving || !dirty}
            title={
              !canEdit
                ? editUnavailableReason
                : settingsSaving
                  ? "Wait for the sequence settings save to finish."
                  : undefined
            }
            aria-label={
              saving ? "Saving" : canEdit ? "Save" : "Save unavailable"
            }
          >
            <Save className="h-4 w-4" />
            <span className="hidden sm:inline">
              {saving ? "Saving..." : "Save"}
            </span>
          </Button>
        </div>
      </div>

      <SequenceAvailabilityNotice
        statusDetail={statusPresentation.detail}
        editUnavailableReason={editUnavailableReason}
      />

      {recoveryBanner}

      {/* SEQ-009: send performance (reached/opened/clicked), collapsible so it
          never crowds the editor. */}
      <SequencePerformancePanel sequenceId={seq.id} />

      {/* automation-77: sequence-level goal / exit criteria + stuck threshold.
          Saves under the page's If-Match version and hands the bumped one
          back so the next email save does not 412. */}
      <SequenceSettingsCard
        sequenceId={seq.id}
        version={seq.version}
        canEdit={canEdit}
        editUnavailableReason={editUnavailableReason}
        busy={saving}
        onSavingChange={setSettingsSaving}
        onSaved={(saved) => {
          if (!saved.version) return;
          setSeq((curr) =>
            curr && curr.id === seq.id
              ? { ...curr, version: saved.version }
              : curr,
          );
        }}
      />

      <div className="grid flex-none grid-cols-1 min-h-0 lg:flex-1 lg:grid-cols-12">
        <aside className="max-h-96 overflow-y-auto border-b bg-card lg:col-span-4 lg:max-h-none lg:border-b-0 lg:border-r xl:col-span-3">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              Sequence steps
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {countSteps(workingSteps)} total
            </span>
          </div>
          {stepCanvas}
        </aside>

        <section className="flex flex-col min-w-0 min-h-0 lg:col-span-8 xl:col-span-9">
          <EmailStepSection
            selected={selected}
            canEdit={canEdit}
            editUnavailableReason={editUnavailableReason}
            editorRevision={editorRevision}
            saving={saving}
            canvasBusy={canvasBusy}
            canvasLockedReason={canvasLockedReason}
            selectedVariantCount={selectedVariantCount}
            subjectSuggestions={subjectSuggestions}
            setSubjectSuggestions={setSubjectSuggestions}
            suggesting={suggesting}
            suggestSubjects={suggestSubjects}
            abTriggerRef={abTriggerRef}
            setAbOpen={setAbOpen}
            onDelayChange={onDelayChange}
            onSubjectChange={onSubjectChange}
            onMarkdownChange={onMarkdownChange}
            onMjmlChange={onMjmlChange}
            onMjmlSourceChange={onMjmlSourceChange}
            onSaveMarkdown={onSaveMarkdown}
            onSaveMjml={onSaveMjml}
          />

          <FidelityBreakdown email={selected} />
        </section>
      </div>

      {regenerationOpen && regenerationTarget ? (
        <RegenerateEmailDialog
          accepting={regenerationPhase === "accepting"}
          candidate={regenerationCandidate}
          currentEmail={regenerationTarget.email}
          emailPosition={regenerationTarget.email.position}
          error={regenerationError}
          generating={regenerationPhase === "generating"}
          hint={regenerationHint}
          onAccept={() => void acceptRegenerationCandidate()}
          onAdjust={() => {
            setRegenerationCandidate(null);
            setRegenerationError(null);
          }}
          onHintChange={(hint) => {
            regenerationIntentRef.current = null;
            setRegenerationHint(hint);
          }}
          onNewAttempt={startNewRegenerationAttempt}
          onOpenChange={(open) => {
            if (!open) resetRegeneration();
          }}
          onRegenerate={() => void requestRegenerationPreview()}
          onStyleChange={(style) => {
            regenerationIntentRef.current = null;
            setRegenerationStyle(style);
          }}
          open={regenerationOpen}
          returnFocus={regenerationTriggerRef}
          style={regenerationStyle}
        />
      ) : null}

      {abOpen ? (
        <SequenceAbVariantsDialog
          emailPosition={selected.position}
          email={{
            subject: selected.subject,
            body: selected.bodyMarkdown,
            ...(selected.bodyHtml ? { body_html: selected.bodyHtml } : {}),
          }}
          variants={selectedVariants}
          canEdit={canEdit && !canvasBusy}
          lockedReason={canvasLockedReason}
          onSave={saveSelectedVariants}
          onClose={() => setAbOpen(false)}
          returnFocus={abTriggerRef}
        />
      ) : null}

      {graphConfirmDialog}
    </div>
  );
}
