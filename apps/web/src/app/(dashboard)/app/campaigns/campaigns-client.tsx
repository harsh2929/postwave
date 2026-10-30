// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { celebrate } from "@/components/delight/confetti";
import { dispatchPwaInstallTrigger } from "@/lib/pwa-install";
import {
  mutKey,
  useFailedMutations,
  usePendingMutations,
} from "@/lib/pending-mutations";
import {
  type Campaign,
  type CreateCampaignInput,
  cancelCampaign,
  cloneCampaign,
  countCampaigns,
  createCampaign,
  createCampaignABTest,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  pauseCampaign,
  resumeCampaign,
  sendCampaign,
} from "@/lib/campaigns-api";
import { listSegments } from "@/lib/segments-api";
import { ALL_FOLDERS } from "@/lib/campaign-folders-api";
import { CampaignBulkActions } from "@/components/campaigns/campaign-bulk-actions";
import {
  CAMPAIGN_VIEW_MODES,
  CampaignCalendar,
  CampaignViewToggle,
} from "@/components/campaigns/campaign-calendar";
import { CampaignFolderFilter } from "@/components/campaigns/campaign-folder-filter";
import { MoveToFolderDialog } from "@/components/campaigns/move-to-folder-dialog";
import {
  isCampaignSnapshotStale,
  RefreshSnapshotButton,
} from "@/components/campaigns/refresh-snapshot-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  CampaignWriteAuthorityError,
  assertFreshCampaignWriteAuthority,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { asRoute } from "@/lib/typed-routes";
import { takeAiCampaignHandoff } from "@/lib/ai-campaign-handoff";

import {
  CampaignCreateDialog,
  type CampaignCreateDraft,
} from "./campaign-create-dialog";
import { CampaignBulkBar } from "./campaign-bulk-bar";
import {
  CAMPAIGN_SORT_KEYS,
  CAMPAIGN_STATUS_FILTERS,
  CAMPAIGN_TYPE_FILTERS,
  type CampaignSortKey,
  type CampaignStatusFilter,
  type CampaignTypeFilter,
  countCampaignStatuses,
  DEFAULT_CAMPAIGN_BODY_HTML,
  filterAndSortCampaigns,
  labelize,
  nextCampaignSort,
  pluralize,
  type SortOrder,
} from "./campaign-list-helpers";
import { CampaignStatsGrid } from "./campaign-stats-grid";
import { CampaignsTable } from "./campaigns-table";
import { SelectedCampaignActions } from "./selected-campaign-actions";

const CampaignIntelligencePanel = lazy(() =>
  import("@/components/mailchimp-parity/campaign-intelligence-panel").then(
    (module) => ({ default: module.CampaignIntelligencePanel }),
  ),
);

const CampaignSendDialog = lazy(() =>
  import("./campaign-send-dialogs").then((module) => ({
    default: module.CampaignSendDialog,
  })),
);

function CampaignIntelligenceSkeleton() {
  return (
    <section
      aria-label="Campaign intelligence loading"
      className="min-h-48 animate-pulse rounded-md border bg-card"
    />
  );
}

function CampaignDialogLoading({ label }: { label: string }) {
  return (
    <p className="sr-only" role="status" aria-live="polite">
      {label}
    </p>
  );
}

const EMPTY_CAMPAIGNS: Campaign[] = [];
const CAMPAIGNS_PER_PAGE = 50;
// The list endpoint returns free-text search results up to a 500-row ceiling
// with no server-side status/type filter or sort, so we fetch the window once
// and filter / sort / paginate on the client (CAMP-012 / CAMP-035).
const CAMPAIGNS_WINDOW = 500;
// How long a single-row delete is held before it commits, so Undo can cancel
// the request instead of orphaning it. The toast lives exactly this long: its
// Undo must not outlive the window it can still cancel.
const DELETE_UNDO_WINDOW_MS = 5000;

const listSchema = {
  page: intParam(1),
  q: stringParam(""),
  status: enumParam(CAMPAIGN_STATUS_FILTERS, "all"),
  type: enumParam(CAMPAIGN_TYPE_FILTERS, "all"),
  sort: enumParam(CAMPAIGN_SORT_KEYS, "updated_at"),
  order: enumParam(["asc", "desc"] as const, "desc"),
  folder: stringParam(ALL_FOLDERS),
  view: enumParam(CAMPAIGN_VIEW_MODES, "list"),
} as const;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function CampaignsClient() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const { state, setState, reset } = useTableUrlState(listSchema);
  const { page, q: search, status, type, sort, order, folder, view } = state;

  const [open, setOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [activeCampaign, setActiveCampaign] = useState<Campaign | null>(null);
  const [secondaryPanelsReady, setSecondaryPanelsReady] = useState(false);
  const [draft, setDraft] = useState<CampaignCreateDraft>({
    name: "",
    subject: "",
  });
  useEffect(() => setSecondaryPanelsReady(true), []);
  const [subject, setSubject] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsFor, setSuggestionsFor] = useState("");
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  // Set when the AI service fails, for the rest of this dialog session: every
  // subject keystroke used to fire a fresh (retried) request at a service
  // that was down, and the box sat on "Thinking..." each time. Cleared by
  // "Try suggestions again" and by reopening the dialog.
  const [suggestUnavailable, setSuggestUnavailable] = useState(false);
  const [abCreateError, setAbCreateError] = useState<string | null>(null);
  const suggestRequestRef = useRef(0);
  // Single-row deletes still inside their Undo window, by campaign id. Each
  // value commits that delete immediately; see handleDelete.
  const pendingDeletesRef = useRef(new Map<string, () => void>());
  const handoffSubjectRef = useRef("");
  const handoffPendingApplyRef = useRef(false);
  const abCreateInFlightRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [searchDraft, setSearchDraft] = useState(search);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The one campaign the row "Move" action opened the folder picker for.
  const [moveTarget, setMoveTarget] = useState<Campaign | null>(null);

  // A pending delete must not die with the page. pagehide is the reliable
  // "this page is going away" signal (it fires on a closed tab, a reload and a
  // real navigation, and on iOS where unload never does); visibilitychange to
  // hidden covers the backgrounding cases pagehide can miss. Both flush every
  // delete whose Undo window has not elapsed, so the row the person watched
  // disappear is actually gone.
  useEffect(() => {
    const flushPendingDeletes = () => {
      for (const commit of [...pendingDeletesRef.current.values()]) commit();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushPendingDeletes();
    };
    window.addEventListener("pagehide", flushPendingDeletes);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flushPendingDeletes);
      document.removeEventListener("visibilitychange", onHidden);
      // Deliberately NOT flushed on unmount: an in-app navigation leaves the
      // toast — and its Undo — on screen, and the window timer outlives this
      // component, so the delete still commits on time.
    };
  }, []);

  // Keep the search box in sync when the URL changes (Back/Forward/deep-link).
  useEffect(() => setSearchDraft(search), [search]);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canWrite = canWriteCampaigns(meQuery.data);

  useEffect(() => {
    if (searchParams.get("create") !== "1" || !meQuery.isFetched) return;
    if (canWrite) {
      const handoff = takeAiCampaignHandoff();
      if (handoff) {
        setDraft({
          name: handoff.name,
          subject: handoff.subject,
          ...(handoff.bodyHtml ? { bodyHtml: handoff.bodyHtml } : {}),
          ...(handoff.previewText ? { previewText: handoff.previewText } : {}),
        });
        setSubject(handoff.subject);
        setSuggestions(handoff.subjectVariants);
        setSuggestionsFor(handoff.subject);
        handoffSubjectRef.current = handoff.subject;
        handoffPendingApplyRef.current = true;
        setSuggestError(null);
        setSuggestLoading(false);
      }
      setOpen(true);
    }
    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("create");
    const query = nextParams.toString();
    router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  }, [canWrite, meQuery.isFetched, pathname, router, searchParams]);

  useEffect(() => {
    if (!meQuery.isFetched || canWrite) return;
    setOpen(false);
    setSendOpen(false);
    setSelected(new Set());
    setMoveTarget(null);
  }, [canWrite, meQuery.isFetched]);
  const campaignsKey = useMemo(
    () => qk.campaigns(tenantId, role, { query: search }),
    [role, search, tenantId],
  );
  const campaignsBaseKey = useMemo(
    () => base("campaigns", tenantId, role),
    [role, tenantId],
  );
  const segmentsKey = useMemo(
    () => qk.segments(tenantId, role, { surface: "campaign-create" }),
    [role, tenantId],
  );
  const campaignsQuery = useQuery({
    queryKey: campaignsKey,
    queryFn: () => listCampaigns({ perPage: CAMPAIGNS_WINDOW, query: search }),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
    // Keep prior rows visible during a search refetch instead of collapsing
    // the table to a single loading row (CAMP-013).
    placeholderData: keepPreviousData,
  });
  const allCountsQuery = useQuery({
    queryKey: [...campaignsBaseKey, "counts", "all"],
    queryFn: () => countCampaigns(),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });
  const segmentsQuery = useQuery({
    queryKey: segmentsKey,
    queryFn: () => listSegments(),
    // The audience picker is dialog-only. Warm it as soon as the dialog opens
    // so generated ideas can become actionable without taxing list-only visits.
    enabled: meQuery.isFetched && open,
    staleTime: STALE.list,
  });

  // A result remains actionable only while it describes the exact trimmed
  // subject on screen. This closes the render-to-effect gap after an edit,
  // before the prior request's cleanup has had a chance to run.
  const normalizedSubject = subject.trim();
  const currentSuggestions =
    suggestionsFor === normalizedSubject ? suggestions : [];

  useEffect(() => {
    if (!campaignsQuery.error) return;
    toast.error("Could not load campaigns.");
  }, [campaignsQuery.error]);

  const windowRows = campaignsQuery.data ?? EMPTY_CAMPAIGNS;
  const loading =
    meQuery.isLoading || (campaignsQuery.isPending && !campaignsQuery.data);
  // A failed refetch over retained rows: the list is a last-confirmed
  // snapshot, and folder/tag writes wait until a refresh succeeds.
  const snapshotStale = isCampaignSnapshotStale(campaignsQuery);

  const filtered = useMemo(
    () =>
      filterAndSortCampaigns(windowRows, {
        query: search,
        status,
        type,
        sort,
        order,
        folder,
      }),
    [windowRows, search, status, type, sort, order, folder],
  );
  const totalCampaigns = filtered.length;
  // apps/api caps per_page at CampaignListMaxRows (500), so a full window means
  // the workspace holds campaigns this table cannot reach at all — the count
  // below is the size of the window, never the workspace total, and the
  // status tiles come from the workspace-wide counts endpoint and will read
  // higher. Say so rather than letting the two numbers disagree in silence.
  const windowTruncated = windowRows.length >= CAMPAIGNS_WINDOW;
  const totalPages = Math.max(
    1,
    Math.ceil(totalCampaigns / CAMPAIGNS_PER_PAGE),
  );
  const pageRows = useMemo(
    () =>
      filtered.slice(
        (page - 1) * CAMPAIGNS_PER_PAGE,
        page * CAMPAIGNS_PER_PAGE,
      ),
    [filtered, page],
  );

  const hasFilter =
    search.length > 0 ||
    status !== "all" ||
    type !== "all" ||
    folder !== ALL_FOLDERS;
  const filterKind: "search" | "status" | "none" = search
    ? "search"
    : status !== "all" || type !== "all" || folder !== ALL_FOLDERS
      ? "status"
      : "none";

  const updateCampaignList = (
    updater: (rows: Campaign[]) => Campaign[],
  ): void => {
    queryClient.setQueryData<Campaign[]>(campaignsKey, (current) =>
      current ? updater(current) : current,
    );
  };

  const invalidateCampaigns = (): void => {
    void queryClient.invalidateQueries({
      queryKey: campaignsBaseKey,
      exact: false,
    });
  };

  const requireCampaignWriteAuthority = async (): Promise<void> => {
    const opened = meQuery.data;
    if (!canWriteCampaigns(opened)) throw new CampaignWriteAuthorityError();
    const fresh = await whoamiFresh();
    // Reflect a mid-session role/viewer-mode change immediately, even when the
    // assertion below rejects the action that was opened under older access.
    queryClient.setQueryData(qk.authMe(), fresh);
    assertFreshCampaignWriteAuthority(opened, fresh);
  };

  useEffect(() => {
    if (page > totalPages) setState({ page: totalPages });
  }, [page, totalPages, setState]);

  // Keep the active-campaign object fresh; clear it if it left the list.
  useEffect(() => {
    if (!activeCampaign) return;
    const next = windowRows.find((c) => c.id === activeCampaign.id);
    if (!next) {
      setActiveCampaign(null);
      return;
    }
    if (next !== activeCampaign) setActiveCampaign(next);
  }, [activeCampaign, windowRows]);

  // Clear selection when the filtered set changes underneath it.
  useEffect(() => {
    setSelected(new Set());
  }, [search, status, type, sort, order, page, folder, view]);

  // The selected rows in list order, for the bulk Move / Tag / Export verbs.
  const selectedRows = useMemo(
    () => filtered.filter((campaign) => selected.has(campaign.id)),
    [filtered, selected],
  );

  useEffect(() => {
    const requestId = ++suggestRequestRef.current;
    const controller = new AbortController();
    // The URL-handoff effect and this effect run from the same initial render.
    // Its normalizedSubject value is therefore still the pre-handoff value.
    // Let the state update land before deciding that the handed subject was
    // edited; otherwise the stale effect clears the one-shot variants and
    // immediately replaces them with a network request.
    if (handoffPendingApplyRef.current) {
      if (handoffSubjectRef.current === normalizedSubject) {
        handoffPendingApplyRef.current = false;
      }
      setSuggestLoading(false);
      return;
    }
    if (handoffSubjectRef.current === normalizedSubject) {
      setSuggestLoading(false);
      return;
    }
    if (handoffSubjectRef.current) handoffSubjectRef.current = "";
    if (normalizedSubject.length < 10) {
      setSuggestions([]);
      setSuggestionsFor("");
      setSuggestLoading(false);
      setSuggestError(null);
      return;
    }
    if (suggestUnavailable) {
      setSuggestLoading(false);
      return;
    }
    setSuggestLoading(true);
    setSuggestError(null);
    const timer = window.setTimeout(() => {
      import("@/lib/voice-api")
        .then((module) => {
          if (suggestRequestRef.current !== requestId) return [];
          return module.generateSubjectSuggestions(normalizedSubject, {
            signal: controller.signal,
          });
        })
        .then((rows) => {
          if (suggestRequestRef.current === requestId) {
            const next = Array.from(
              new Set(rows.map((row) => row.trim()).filter(Boolean)),
            ).slice(0, 8);
            setSuggestions(next);
            setSuggestionsFor(normalizedSubject);
            setSuggestError(
              next.length
                ? null
                : "No distinct suggestions came back. Try editing your subject.",
            );
          }
        })
        .catch(() => {
          if (suggestRequestRef.current === requestId) {
            setSuggestions([]);
            setSuggestionsFor(normalizedSubject);
            setSuggestError(null);
            setSuggestUnavailable(true);
          }
        })
        .finally(() => {
          if (suggestRequestRef.current === requestId) {
            setSuggestLoading(false);
          }
        });
    }, 500);
    return () => {
      if (suggestRequestRef.current === requestId) {
        suggestRequestRef.current += 1;
      }
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [normalizedSubject, suggestUnavailable]);

  // Warm the link validator while the name and subject are typed, so the
  // Create click does not wait on its chunk. A failed prefetch is harmless:
  // handleCreate imports it again and reports a real failure itself.
  useEffect(() => {
    if (!open) return;
    void import("@/lib/campaign-block-renderer").catch(() => undefined);
  }, [open]);

  const stats = useMemo(() => {
    const counts = allCountsQuery.data?.by_status;
    return counts
      ? {
          drafts: counts.draft ?? 0,
          scheduled: counts.scheduled ?? 0,
          sent: counts.sent ?? 0,
        }
      : countCampaignStatuses(windowRows);
  }, [allCountsQuery.data, windowRows]);

  const closeCreate = (next: boolean) => {
    if (next) {
      if (!canWrite) return;
      setOpen(true);
      // Cancel intentionally preserves the local draft. Re-seed AI from that
      // draft on reopen instead of showing a filled subject with no matching
      // suggestions or request in flight.
      setSubject(draft.subject);
      return;
    }
    if (abCreateInFlightRef.current) return;
    setOpen(false);
    suggestRequestRef.current += 1;
    setSubject("");
    setSuggestions([]);
    setSuggestionsFor("");
    setSuggestLoading(false);
    setSuggestError(null);
    setSuggestUnavailable(false);
    setAbCreateError(null);
  };

  const createCampMut = useMutation<Campaign, Error, CreateCampaignInput>({
    mutationKey: mutKey("campaigns", "create"),
    mutationFn: async (input) => {
      await requireCampaignWriteAuthority();
      return createCampaign(input);
    },
  });
  const createABTestMut = useMutation<
    Awaited<ReturnType<typeof createCampaignABTest>>,
    Error,
    Parameters<typeof createCampaignABTest>[0]
  >({
    // Keep this out of the regular `campaigns/create` pending-row selector:
    // its variables and response describe a parent + children transaction,
    // not one retryable CreateCampaignInput row.
    mutationKey: ["campaign-ab-tests", "create"] as const,
    mutationFn: async (input) => {
      await requireCampaignWriteAuthority();
      return createCampaignABTest(input);
    },
  });
  const pendingCampaignCreates = usePendingMutations<CreateCampaignInput>(
    "campaigns",
    "create",
  );
  const failedCampaignCreates = useFailedMutations<CreateCampaignInput>(
    "campaigns",
    "create",
  );

  const handleCreate = async () => {
    if (!canWrite || abCreateInFlightRef.current) return;
    const name = draft.name.trim();
    const subjectValue = draft.subject.trim();
    if (!name || !subjectValue) {
      toast.error("Name and subject are required.");
      return;
    }
    const bodyHTML = draft.bodyHtml?.trim()
      ? draft.bodyHtml
      : DEFAULT_CAMPAIGN_BODY_HTML;
    // The starter body is a fixed, reviewed constant; only a body someone
    // supplied (an AI handoff) needs the parser-backed link check.
    if (bodyHTML !== DEFAULT_CAMPAIGN_BODY_HTML) {
      let contentLinkError: string | null;
      try {
        const { campaignHTMLLinkError } =
          await import("@/lib/campaign-block-renderer");
        contentLinkError = campaignHTMLLinkError(bodyHTML, "Campaign HTML");
      } catch (error) {
        toast.error(
          errorMessage(error, "Campaign links could not be validated."),
        );
        return;
      }
      if (contentLinkError) {
        toast.error(contentLinkError);
        return;
      }
    }
    const input: CreateCampaignInput = {
      name,
      subject: subjectValue,
      body_html: bodyHTML,
      ...(draft.previewText?.trim()
        ? { preview_text: draft.previewText.trim() }
        : {}),
    };
    setAbCreateError(null);
    try {
      const c = await createCampMut.mutateAsync(input);
      updateCampaignList((cur) => [c, ...cur]);
      invalidateCampaigns();
      suggestRequestRef.current += 1;
      setDraft({ name: "", subject: "" });
      setSubject("");
      setSuggestions([]);
      setSuggestionsFor("");
      setSuggestUnavailable(false);
      setOpen(false);
      toast.success("Campaign created.");
      // The dialog promises "you'll build the email next": take them there.
      router.push(asRoute(`/app/campaigns/${c.id}`));
    } catch (error) {
      toast.error(errorMessage(error, "Could not create campaign."));
    }
  };

  const handleCreateABTest = async (segmentId: string) => {
    if (!canWrite || abCreateInFlightRef.current) return;
    const variants = Array.from(
      new Set(currentSuggestions.map((value) => value.trim()).filter(Boolean)),
    ).slice(0, 8);
    if (variants.length < 2) {
      const message = "At least two distinct subject ideas are required.";
      setAbCreateError(message);
      toast.error(message);
      return;
    }
    if (!segmentId) {
      const message = "Choose a saved segment for this A/B test.";
      setAbCreateError(message);
      toast.error(message);
      return;
    }

    const name = draft.name.trim() || draft.subject.trim();
    if (!name) {
      const message = "Add a campaign name or subject before creating a test.";
      setAbCreateError(message);
      toast.error(message);
      return;
    }
    const bodyHTML = draft.bodyHtml?.trim()
      ? draft.bodyHtml
      : DEFAULT_CAMPAIGN_BODY_HTML;
    let contentLinkError: string | null;
    try {
      const { campaignHTMLLinkError } =
        await import("@/lib/campaign-block-renderer");
      contentLinkError = campaignHTMLLinkError(bodyHTML, "Campaign A/B HTML");
    } catch (error) {
      const message = errorMessage(
        error,
        "Campaign A/B links could not be validated.",
      );
      setAbCreateError(message);
      toast.error(message);
      return;
    }
    if (contentLinkError) {
      setAbCreateError(contentLinkError);
      toast.error(contentLinkError);
      return;
    }

    abCreateInFlightRef.current = true;
    setAbCreateError(null);
    try {
      const created = await createABTestMut.mutateAsync({
        name,
        subject_variants: variants,
        audience_segment_id: segmentId,
        body_html: bodyHTML,
        ...(draft.previewText?.trim()
          ? { preview_text: draft.previewText.trim() }
          : {}),
      });
      const createdRows = [created.parent, ...created.children];
      const createdIds = new Set(createdRows.map((campaign) => campaign.id));
      updateCampaignList((current) => [
        ...createdRows,
        ...current.filter((campaign) => !createdIds.has(campaign.id)),
      ]);
      invalidateCampaigns();
      suggestRequestRef.current += 1;
      setDraft({ name: "", subject: "" });
      setSubject("");
      setSuggestions([]);
      setSuggestionsFor("");
      setSuggestLoading(false);
      setSuggestError(null);
      setAbCreateError(null);
      setOpen(false);
      toast.success("A/B test created.", {
        description: `${created.children.length} subject variants are ready to review.`,
        action: {
          label: "Open test",
          onClick: () =>
            router.push(asRoute(`/app/campaigns/${created.parent.id}/ab`)),
        },
      });
    } catch (error) {
      const message = errorMessage(error, "Could not finish the A/B test.");
      const recovery =
        "Your draft is still here. Check the campaign list before retrying because part of the test may have been created.";
      setAbCreateError(`${message} ${recovery}`);
      toast.error(message, { description: recovery });
    } finally {
      abCreateInFlightRef.current = false;
    }
  };

  // Deferred delete with Undo (CAMP-014): remove the row optimistically and
  // hold the API call for a few seconds so Undo can cancel it before it
  // commits — no orphaned request when the user reverts.
  //
  // The hold used to live only in a window timer, so a tab closed inside the
  // window took the DELETE with it: the row had disappeared, the person had
  // every reason to believe the campaign was gone, and it was still there on
  // their next visit. Each pending delete is now registered below and flushed
  // when the page goes away (pagehide / visibilitychange), with a keepalive
  // request the browser finishes without us. The Undo window is therefore "for
  // as long as this page is on screen", which is the only window the Undo
  // button itself is reachable in.
  const handleDelete = async (campaign: Campaign) => {
    try {
      await requireCampaignWriteAuthority();
    } catch (error) {
      toast.error(errorMessage(error, CAMPAIGN_READ_ONLY_MESSAGE));
      return;
    }
    updateCampaignList((cur) => cur.filter((c) => c.id !== campaign.id));
    if (activeCampaign?.id === campaign.id) setActiveCampaign(null);
    // One id for the whole life of the deferred delete, so the outcome
    // replaces the pending notice in place rather than stacking under it.
    const toastId = `campaign-delete-${campaign.id}`;
    // Whichever of the three endings happens first — the window elapsing, the
    // page going away, Undo — wins; the other two become no-ops.
    let settled = false;
    const release = () => {
      settled = true;
      window.clearTimeout(timer);
      pendingDeletesRef.current.delete(campaign.id);
    };
    const commit = async (trigger: "window" | "unload") => {
      if (settled) return;
      release();
      try {
        // The authority used to open the confirmation can expire during the
        // undo window, so re-check at the actual destructive commit point. Not
        // on the unload path: that check is a round trip of its own, which the
        // page will not be alive to finish, and the server authorises the
        // delete itself in any case.
        if (trigger === "window") await requireCampaignWriteAuthority();
        await deleteCampaign(campaign.id, {
          beforeUnload: trigger === "unload",
        });
        invalidateCampaigns();
        if (trigger === "window") {
          toast.success("Campaign deleted.", { id: toastId });
        }
      } catch (error) {
        // On the unload path there is nobody left to tell, and the campaign
        // survives — which is the same outcome as before this request existed.
        if (trigger === "window") {
          toast.error(errorMessage(error, "Delete failed."), { id: toastId });
          invalidateCampaigns();
        }
      }
    };
    const timer = window.setTimeout(
      () => void commit("window"),
      DELETE_UNDO_WINDOW_MS,
    );
    pendingDeletesRef.current.set(campaign.id, () => void commit("unload"));
    // Past tense would be a lie for the length of the window: nothing has been
    // sent yet. Claiming "deleted" here is how a campaign comes back with no
    // explanation — so the success line is deferred to the branch above, where
    // the DELETE resolved.
    toast(
      `Deleting "${campaign.name || "Untitled campaign"}" — undo to keep it.`,
      {
        id: toastId,
        duration: DELETE_UNDO_WINDOW_MS,
        action: {
          label: "Undo",
          onClick: () => {
            if (settled) return;
            release();
            invalidateCampaigns();
            // Deliberately NOT `toastId`. sonner dismisses the toast an action
            // belongs to immediately after the handler returns, so a
            // confirmation reusing that id is created and then torn down in the
            // same tick — the undo worked but said nothing. The two commit
            // branches above still reuse `toastId`, because there the point is
            // to replace the pending notice in place.
            toast.success("Delete undone.", { id: `${toastId}-undone` });
          },
        },
      },
    );
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    if (!canWrite || ids.length === 0) return;
    try {
      await requireCampaignWriteAuthority();
    } catch (error) {
      toast.error(errorMessage(error, CAMPAIGN_READ_ONLY_MESSAGE));
      return;
    }
    updateCampaignList((cur) => cur.filter((c) => !selected.has(c.id)));
    if (activeCampaign && selected.has(activeCampaign.id))
      setActiveCampaign(null);
    setSelected(new Set());
    const results = await Promise.allSettled(
      ids.map((id) => deleteCampaign(id)),
    );
    invalidateCampaigns();
    const failures = results.filter((r) => r.status === "rejected").length;
    if (failures > 0) {
      toast.error(
        `Deleted ${ids.length - failures} of ${ids.length}; ${failures} failed.`,
      );
    } else {
      toast.success(`Deleted ${pluralize(ids.length, "campaign")}.`);
    }
  };

  const handleDuplicate = async (campaign: Campaign) => {
    try {
      await requireCampaignWriteAuthority();
      const clone = await cloneCampaign(campaign.id);
      invalidateCampaigns();
      toast.success("Campaign duplicated.", {
        action: {
          label: "Open",
          onClick: () => router.push(asRoute(`/app/campaigns/${clone.id}`)),
        },
      });
      router.push(asRoute(`/app/campaigns/${clone.id}`));
    } catch (error) {
      toast.error(errorMessage(error, "Could not duplicate campaign."));
    }
  };

  const handleSend = async () => {
    if (!canWrite || !activeCampaign) return;
    setSending(true);
    try {
      await requireCampaignWriteAuthority();
      const persisted = await getCampaign(activeCampaign.id);
      const { validateCampaignContentLinks } =
        await import("./[id]/use-campaign-save-workflow");
      const contentLinkError = await validateCampaignContentLinks(persisted);
      if (contentLinkError) {
        toast.error(contentLinkError);
        return;
      }
      // Link validation is asynchronous; close the validation-to-send race.
      await requireCampaignWriteAuthority();
      const res = await sendCampaign(activeCampaign.id);
      if ("campaign_id" in res && res.status === "approval_required") {
        toast.message("Approval requested.", {
          description: res.approval_id
            ? `Approval ${res.approval_id} is pending.`
            : undefined,
        });
        setSendOpen(false);
        // Requesting approval changes server state, so returning early without
        // this left the row rendering as though nothing had been attempted.
        invalidateCampaigns();
        return;
      }
      if ("id" in res) {
        updateCampaignList((cur) =>
          cur.map((c) => (c.id === res.id ? res : c)),
        );
        setActiveCampaign(res);
      }
      setSendOpen(false);
      invalidateCampaigns();
      if (
        "campaign_id" in res &&
        res.assurance_rollout_mode === "warn" &&
        res.assurance_status !== "ok"
      ) {
        toast.warning(
          "Campaign queued with a Campaign Assurance advisory. Review the current assurance result before warning mode advances to blocking.",
        );
      } else {
        toast.success("On its way - your campaign is sending.");
      }
      dispatchPwaInstallTrigger("postwave:campaign-sent");
      try {
        if (!localStorage.getItem("pw:celebrated:first-send")) {
          celebrate();
          localStorage.setItem("pw:celebrated:first-send", "1");
        }
      } catch {
        // localStorage unavailable (private mode etc.) - skip the flourish.
      }
    } catch (error) {
      toast.error(errorMessage(error, "Could not start send."));
    } finally {
      setSending(false);
    }
  };

  const handleTransition = async (
    campaign: Campaign,
    action: "pause" | "resume" | "cancel",
  ) => {
    if (!canWrite) return;
    setTransitioningId(campaign.id);
    try {
      await requireCampaignWriteAuthority();
      const updated =
        action === "pause"
          ? await pauseCampaign(campaign.id)
          : action === "resume"
            ? await resumeCampaign(campaign.id)
            : await cancelCampaign(campaign.id);
      updateCampaignList((current) =>
        current.map((row) => (row.id === updated.id ? updated : row)),
      );
      if (activeCampaign?.id === updated.id) setActiveCampaign(updated);
      invalidateCampaigns();
      toast.success(
        action === "pause"
          ? "Campaign paused."
          : action === "resume"
            ? "Campaign resumed."
            : "Campaign cancelled.",
      );
    } catch (error) {
      toast.error(errorMessage(error, `Could not ${action} campaign.`));
    } finally {
      setTransitioningId(null);
    }
  };

  // Selection helpers (CAMP-005).
  const allOnPageSelected =
    pageRows.length > 0 && pageRows.every((c) => selected.has(c.id));
  const toggleRow = (id: string) => {
    if (!canWrite) return;
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllOnPage = () => {
    if (!canWrite) return;
    setSelected(
      allOnPageSelected ? new Set() : new Set(pageRows.map((c) => c.id)),
    );
  };

  const setStatusFilter = (next: CampaignStatusFilter) =>
    setState({ status: status === next ? "all" : next, page: 1 });

  const handleSort = (key: CampaignSortKey) => {
    const nextState = nextCampaignSort({ sort, order }, key);
    setState({
      sort: nextState.sort,
      order: nextState.order as SortOrder,
      page: 1,
    });
  };

  const clearAllFilters = () => {
    setSearchDraft("");
    reset();
    // Clearing filters (folder included) is not a request to leave the
    // calendar; `setState` merges over the just-reset state.
    if (view !== "list") setState({ view });
  };

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Campaigns
          </h1>
          {campaignsQuery.isError ? (
            // A failed list must not read as "this workspace has none".
            <p className="text-sm text-destructive mt-1">
              Could not load campaigns.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">
              {hasFilter ? "Showing " : ""}
              {pluralize(totalCampaigns, "campaign")}
              {hasFilter ? " matching your filters." : "."}
            </p>
          )}
          {!campaignsQuery.isError && windowTruncated ? (
            <p
              className="mt-1 max-w-2xl text-sm text-muted-foreground"
              role="note"
            >
              This table covers only the {CAMPAIGNS_WINDOW.toLocaleString()}{" "}
              most recently updated campaigns, so the count above is not the
              workspace total. Search by name to reach older ones.
            </p>
          ) : null}
          {meQuery.isFetched && !canWrite ? (
            <p
              className="mt-2 max-w-2xl text-sm text-muted-foreground"
              role="note"
            >
              {CAMPAIGN_READ_ONLY_MESSAGE}
            </p>
          ) : null}
        </div>
        <CampaignCreateDialog
          abCreateError={abCreateError}
          audienceError={
            segmentsQuery.isError &&
            !segmentsQuery.isFetching &&
            !segmentsQuery.data
          }
          audienceLoading={
            !segmentsQuery.data &&
            (segmentsQuery.isPending || segmentsQuery.isFetching)
          }
          audienceSegments={
            Array.isArray(segmentsQuery.data) ? segmentsQuery.data : []
          }
          creatingABTest={createABTestMut.isPending}
          canWrite={canWrite}
          draft={draft}
          onCreate={handleCreate}
          onCreateABTest={(segmentId) => void handleCreateABTest(segmentId)}
          onDraftChange={setDraft}
          onOpenChange={closeCreate}
          onRetryAudiences={() => void segmentsQuery.refetch()}
          onRetrySuggestions={() => setSuggestUnavailable(false)}
          onSubjectChange={(nextSubject) => {
            setAbCreateError(null);
            setSubject(nextSubject);
          }}
          open={open}
          readOnlyMessage={CAMPAIGN_READ_ONLY_MESSAGE}
          suggestions={currentSuggestions}
          suggestError={
            suggestionsFor === normalizedSubject ? suggestError : null
          }
          suggestLoading={suggestLoading}
          suggestUnavailable={suggestUnavailable}
        />
      </header>

      <CampaignStatsGrid
        {...stats}
        activeFilter={status}
        onFilter={setStatusFilter}
      />
      {allCountsQuery.isError ? (
        // The grid silently falls back to window-derived counts; say so rather
        // than presenting a partial total as the workspace-wide one.
        <p className="text-sm text-destructive">
          Could not load campaign status totals — the counts above cover only
          the campaigns loaded here.
        </p>
      ) : null}

      {secondaryPanelsReady ? (
        <Suspense fallback={<CampaignIntelligenceSkeleton />}>
          <CampaignIntelligencePanel
            campaignId={activeCampaign?.id}
            className="min-w-0 [&_label]:min-h-8"
          />
        </Suspense>
      ) : (
        <CampaignIntelligenceSkeleton />
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <form
          className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            setState({ q: searchDraft.trim(), page: 1 });
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 pr-9"
              aria-label="Search campaigns"
              placeholder="Search name or subject"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            {searchDraft ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearchDraft("");
                  setState({ q: "", page: 1 });
                }}
                className="absolute right-1 top-1/2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <Select
          aria-label="Filter by type"
          className="sm:w-48"
          value={type}
          onChange={(event) =>
            setState({
              type: event.target.value as CampaignTypeFilter,
              page: 1,
            })
          }
        >
          {CAMPAIGN_TYPE_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All types" : labelize(value)}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
        <CampaignFolderFilter
          identity={meQuery.data}
          tenantId={tenantId}
          role={role}
          value={folder}
          onChange={(nextFolder) => setState({ folder: nextFolder, page: 1 })}
          snapshotStale={snapshotStale}
        />
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <CampaignViewToggle
            value={view}
            onChange={(nextView) => setState({ view: nextView })}
          />
          <div className="min-w-0 flex-1">
            <RefreshSnapshotButton
              queryKey={campaignsBaseKey}
              stale={snapshotStale}
              lastConfirmedAt={campaignsQuery.dataUpdatedAt}
              loadedCount={windowRows.length}
              error={campaignsQuery.error}
            />
          </div>
        </div>
      </div>

      {hasFilter ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {status !== "all" ? (
            <button
              type="button"
              onClick={() => setStatusFilter(status)}
              className="inline-flex min-h-7 items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-0.5"
            >
              Status: {labelize(status)}
              <X className="h-3 w-3" />
            </button>
          ) : null}
          {type !== "all" ? (
            <button
              type="button"
              onClick={() => setState({ type: "all", page: 1 })}
              className="inline-flex min-h-7 items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2.5 py-0.5"
            >
              Type: {labelize(type)}
              <X className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={clearAllFilters}
            className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear all
          </button>
        </div>
      ) : null}

      <CampaignBulkBar
        canWrite={canWrite}
        count={selected.size}
        extraActions={
          <CampaignBulkActions
            identity={meQuery.data}
            tenantId={tenantId}
            role={role}
            selected={selectedRows}
            snapshotStale={snapshotStale}
            onMoved={({ movedIds }) =>
              setSelected(
                (current) =>
                  new Set([...current].filter((id) => !movedIds.includes(id))),
              )
            }
            onTagged={() => setSelected(new Set())}
          />
        }
        onClear={() => setSelected(new Set())}
        onDelete={handleBulkDelete}
        readOnlyMessage={CAMPAIGN_READ_ONLY_MESSAGE}
      />

      {view === "calendar" ? (
        <CampaignCalendar campaigns={filtered} />
      ) : (
        <div
          data-tour="dashboard-campaign-library"
          className="space-y-6 scroll-mt-40"
        >
          <CampaignsTable
            canWrite={canWrite}
            campaigns={pageRows}
            failedCampaignCreates={failedCampaignCreates}
            loading={loading}
            hasFilter={hasFilter}
            filterKind={filterKind}
            searchTerm={search}
            onClearFilters={clearAllFilters}
            activeCampaignId={activeCampaign?.id ?? null}
            selected={selected}
            allOnPageSelected={allOnPageSelected}
            onToggleRow={toggleRow}
            onToggleAllOnPage={toggleAllOnPage}
            sort={sort}
            order={order}
            onSort={handleSort}
            onDeleteCampaign={handleDelete}
            onDuplicateCampaign={handleDuplicate}
            onMoveCampaign={(campaign) => {
              if (canWrite) setMoveTarget(campaign);
            }}
            onOpenCreate={() => closeCreate(true)}
            onRetryCreate={(vars) => {
              if (!canWrite) return;
              createCampMut.mutateAsync(vars).catch(() => {
                /* surfaced via failed-row */
              });
            }}
            onSelectCampaign={setActiveCampaign}
            onTransitionCampaign={handleTransition}
            pendingCampaignCreates={pendingCampaignCreates}
            readOnlyMessage={CAMPAIGN_READ_ONLY_MESSAGE}
            transitioningId={transitioningId}
          />

          {totalPages > 1 ? (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                Page {page.toLocaleString()} of {totalPages.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setState({ page: Math.max(1, page - 1) })}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() =>
                    setState({ page: Math.min(totalPages, page + 1) })
                  }
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <MoveToFolderDialog
        identity={meQuery.data}
        tenantId={tenantId}
        role={role}
        campaigns={moveTarget ? [moveTarget] : []}
        open={moveTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setMoveTarget(null);
        }}
        snapshotStale={snapshotStale}
      />

      {activeCampaign ? (
        <SelectedCampaignActions
          canWrite={canWrite}
          campaign={activeCampaign}
          onSend={() => {
            if (canWrite) setSendOpen(true);
          }}
          readOnlyMessage={CAMPAIGN_READ_ONLY_MESSAGE}
        />
      ) : null}

      {sendOpen ? (
        <Suspense
          fallback={<CampaignDialogLoading label="Loading send dialog" />}
        >
          <CampaignSendDialog
            campaign={activeCampaign}
            tenantId={tenantId}
            role={role}
            onConfirm={handleSend}
            onOpenChange={setSendOpen}
            open
            sending={sending}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
