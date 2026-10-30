// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bookmark,
  FolderPlus,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  buildLookalikeAudience,
  type LookalikeAudienceReceipt,
} from "@/lib/data-operations-api";
import { base, STALE } from "@/lib/query-keys";
import {
  MAX_COMPARE_SEGMENTS,
  PRESET_MEMBER_PAGE_SIZE,
  compareSegmentPnL,
  createStrictSegmentFolder,
  deleteStrictSegmentFolder,
  getSavedSegmentAggregatePreview,
  getSegmentEngagementMetrics,
  getSegmentGrowthMetrics,
  listPresetSegmentMembers,
  listPresetSegmentRecipes,
  listSavedSegmentBookmarks,
  listStrictSegmentFolders,
  patchSavedSegmentBookmark,
  renameStrictSegmentFolder,
  type PresetSegmentRecipe,
  type SavedSegmentAggregatePreview,
  type SavedSegmentBookmark,
  type StrictSegmentFolder,
} from "@/lib/segment-parity-api";
import type { AuthRole } from "@/lib/auth-api";
import type { Segment } from "@/lib/segments-api";

interface SegmentParitySuiteProps {
  segments: Segment[];
  tenantId: string;
  role: AuthRole | null;
  identityReady: boolean;
  identityLoading: boolean;
  identityError: boolean;
  onRetryIdentity: () => void;
  canMutate: boolean;
}

export function SegmentParitySuite(props: SegmentParitySuiteProps) {
  if (props.identityLoading) {
    return (
      <section
        aria-busy="true"
        aria-label="Segment tools"
        className="rounded-xl border bg-card p-5"
      >
        <p className="text-sm text-muted-foreground">
          Loading workspace segment tools…
        </p>
      </section>
    );
  }
  if (props.identityError || !props.identityReady) {
    return (
      <section className="rounded-xl border border-destructive/40 bg-card p-5">
        <p role="alert" className="text-sm text-destructive">
          Workspace identity could not be verified, so tenant data and write
          controls are unavailable.
        </p>
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          onClick={props.onRetryIdentity}
        >
          <RefreshCw className="h-4 w-4" /> Retry identity
        </Button>
      </section>
    );
  }
  return (
    <div className="space-y-6" data-testid="segment-parity-suite">
      <div className="grid gap-4 lg:grid-cols-2">
        <LookalikePanel {...props} />
        <PerformancePanel {...props} />
      </div>
      <PresetRecipesPanel {...props} />
      <SavedSegmentOrganizer {...props} />
    </div>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function ReadOnlyNotice() {
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      Viewer mode is read-only. Exit viewer mode or ask an editor to make
      changes.
    </p>
  );
}

function LookalikePanel({ segments, canMutate }: SegmentParitySuiteProps) {
  const [open, setOpen] = React.useState(false);
  const [seedId, setSeedId] = React.useState(segments[0]?.id ?? "");
  const [name, setName] = React.useState("");
  const [size, setSize] = React.useState(1_000);
  const [confidence, setConfidence] = React.useState("");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [receipt, setReceipt] = React.useState<LookalikeAudienceReceipt | null>(
    null,
  );
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  React.useEffect(() => {
    if (!segments.some((segment) => segment.id === seedId))
      setSeedId(segments[0]?.id ?? "");
  }, [segments, seedId]);

  const seed = segments.find((segment) => segment.id === seedId);
  const knownTooSmall = seed?.lastCount != null && seed.lastCount < 50;
  const confidenceNumber = confidence.trim() ? Number(confidence) : null;
  const valid =
    Boolean(seedId) &&
    Number.isInteger(size) &&
    size >= 100 &&
    size <= 10_000 &&
    !knownTooSmall &&
    acknowledged &&
    (confidenceNumber === null ||
      (confidenceNumber >= 0.5 && confidenceNumber <= 1)) &&
    new TextEncoder().encode(name.trim()).byteLength <= 120;

  async function create() {
    if (!valid || pendingRef.current || !canMutate) return;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await buildLookalikeAudience(
        {
          seed_segment_id: seedId,
          size,
          confidence_threshold: confidenceNumber,
          data_use_acknowledged: true,
          ...(name.trim() ? { name: name.trim() } : {}),
        },
        { signal: requestController.signal },
      );
      setReceipt(result);
      toast.success("Lookalike audience created.");
    } catch (cause) {
      if (requestController.signal.aborted) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create the lookalike audience.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-5">
      <PanelHeader
        icon={Sparkles}
        title="Lookalike audience"
        description="Build a modeled audience from one saved segment and first-party signals."
      />
      <Button
        className="mt-4"
        type="button"
        onClick={() => {
          setError(null);
          setReceipt(null);
          setAcknowledged(false);
          setOpen(true);
        }}
        disabled={!canMutate || segments.length === 0}
      >
        Create lookalike
      </Button>
      {segments.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Create a seed segment first.
        </p>
      ) : null}
      {!canMutate ? <ReadOnlyNotice /> : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pendingRef.current) {
            setOpen(next);
            if (!next) controller.current?.abort();
          }
        }}
      >
        <DialogContent
          closeDisabled={pending}
          onEscapeKeyDown={(event) => pending && event.preventDefault()}
          onPointerDownOutside={(event) => pending && event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Create lookalike audience</DialogTitle>
            <DialogDescription>
              Seed segments need at least 50 current members. The server
              rechecks membership before modeling.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4" aria-busy={pending}>
            <div className="space-y-2">
              <Label htmlFor="lookalike-seed">Seed segment</Label>
              <select
                id="lookalike-seed"
                className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                value={seedId}
                onChange={(e) => setSeedId(e.target.value)}
                disabled={pending}
              >
                {segments.map((segment) => (
                  <option key={segment.id} value={segment.id}>
                    {segment.name}
                    {segment.lastCount != null
                      ? ` (${segment.lastCount.toLocaleString()})`
                      : ""}
                  </option>
                ))}
              </select>
              {knownTooSmall ? (
                <p role="alert" className="text-xs text-destructive">
                  This segment’s last known size is below the 50-member minimum.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="lookalike-name">Name (optional)</Label>
              <Input
                id="lookalike-name"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="lookalike-size">Audience size</Label>
                <Input
                  id="lookalike-size"
                  type="number"
                  min={100}
                  max={10000}
                  step={100}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                  disabled={pending}
                />
                <p className="text-xs text-muted-foreground">
                  100–10,000 members
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lookalike-confidence">
                  Minimum confidence (optional)
                </Label>
                <Input
                  id="lookalike-confidence"
                  type="number"
                  min={0.5}
                  max={1}
                  step={0.05}
                  placeholder="No minimum"
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value)}
                  disabled={pending}
                />
                <p className="text-xs text-muted-foreground">0.50–1.00</p>
              </div>
            </div>
            <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
              <input
                className="mt-1 size-4"
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                disabled={pending}
              />
              <span>
                I acknowledge that Moosewave will model this audience using
                first-party email-domain, signup-source, engagement, and churn
                signals. No third-party audience data is added.
              </span>
            </label>
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                <p>{error}</p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void create()}
                  disabled={!valid || pending}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {receipt ? (
              <div
                role="status"
                className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm"
              >
                <p className="font-medium">{receipt.name}</p>
                <p>
                  {receipt.member_count.toLocaleString()} of{" "}
                  {receipt.size_requested.toLocaleString()} requested members ·{" "}
                  {receipt.seed_count.toLocaleString()} seed members ·{" "}
                  {receipt.status}
                </p>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Close
            </Button>
            <Button onClick={() => void create()} disabled={!valid || pending}>
              {pending ? "Creating…" : "Create audience"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PresetRecipesPanel(props: SegmentParitySuiteProps) {
  const { tenantId, role, identityReady, canMutate } = props;
  const router = useRouter();
  const key = React.useMemo(
    () => base("segment-preset-recipes", tenantId, role),
    [tenantId, role],
  );
  const query = useQuery({
    queryKey: key,
    enabled: identityReady,
    staleTime: STALE.list,
    queryFn: ({ signal }) => listPresetSegmentRecipes(signal),
  });
  const [preview, setPreview] = React.useState<PresetSegmentRecipe | null>(
    null,
  );
  const [offset, setOffset] = React.useState(0);
  const [review, setReview] = React.useState<PresetSegmentRecipe | null>(null);
  const membersKey = React.useMemo(
    () => [...key, "members", preview?.key ?? "", offset],
    [key, preview?.key, offset],
  );
  const members = useQuery({
    queryKey: membersKey,
    enabled: Boolean(preview),
    staleTime: 15_000,
    queryFn: ({ signal }) =>
      listPresetSegmentMembers(preview!.key, {
        limit: PRESET_MEMBER_PAGE_SIZE,
        offset,
        signal,
      }),
  });
  const openPreview = (recipe: PresetSegmentRecipe) => {
    setOffset(0);
    setPreview(recipe);
  };
  const goToBuilder = (recipe: PresetSegmentRecipe) => {
    const params = new URLSearchParams({
      seedName: recipe.label,
      seedDescription: recipe.description,
      seedNaturalLanguage: recipe.description,
    });
    router.push(`/app/subscribers/segments/new?${params.toString()}`);
  };
  return (
    <section className="rounded-xl border bg-card p-5">
      <PanelHeader
        icon={Users}
        title="Preset recipes"
        description="Preview live members, then review a recipe in the builder before saving it."
      />
      {query.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground" aria-busy="true">
          Loading preset recipes…
        </p>
      ) : null}
      {query.isError ? (
        <div className="mt-4" role="alert">
          <p className="text-sm text-destructive">
            Preset recipes could not be loaded.
          </p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </Button>
        </div>
      ) : null}
      {query.isSuccess && query.data.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No preset recipes are configured for this workspace.
        </p>
      ) : null}
      {query.isSuccess && query.data.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {query.data.map((recipe) => (
            <article
              key={recipe.key}
              className="flex flex-col rounded-lg border p-4"
            >
              <h3 className="font-medium">{recipe.label}</h3>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">
                {recipe.description}
              </p>
              <p className="mt-3 text-sm font-medium tabular-nums">
                {recipe.count.toLocaleString()} current members
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openPreview(recipe)}
                >
                  Preview members
                </Button>
                <Button
                  size="sm"
                  onClick={() => setReview(recipe)}
                  disabled={!canMutate}
                >
                  Review recipe
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {!canMutate ? <ReadOnlyNotice /> : null}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => !open && setPreview(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.label ?? "Preset members"}</DialogTitle>
            <DialogDescription>
              Member addresses are shown only in this explicit preview. The card
              count is live guidance; page availability comes from each verified
              response.
            </DialogDescription>
          </DialogHeader>
          {members.isLoading ? (
            <p aria-busy="true" className="text-sm text-muted-foreground">
              Loading members…
            </p>
          ) : null}
          {members.isError ? (
            <div role="alert">
              <p className="text-sm text-destructive">
                Members could not be loaded.
              </p>
              <Button
                className="mt-2"
                size="sm"
                variant="outline"
                onClick={() => void members.refetch()}
              >
                <RefreshCw className="h-4 w-4" /> Retry
              </Button>
            </div>
          ) : null}
          {members.isSuccess && members.data.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No members are on this verified page.
            </p>
          ) : null}
          {members.isSuccess && members.data.members.length > 0 ? (
            <div
              role="region"
              aria-label="Segment members"
              tabIndex={0}
              className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th scope="col" className="px-2 py-2">
                      Email
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Status
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Joined
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {members.data.members.map((member) => (
                    <tr key={member.id} className="border-b">
                      <td className="px-2 py-2">{member.email}</td>
                      <td className="px-2 py-2">{member.status}</td>
                      <td className="whitespace-nowrap px-2 py-2">
                        {new Date(member.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <DialogFooter>
            <span className="mr-auto self-center text-xs text-muted-foreground">
              {members.isSuccess && members.data.members.length
                ? `${offset + 1}–${offset + members.data.members.length}`
                : "0 members"}
            </span>
            <Button
              variant="outline"
              disabled={offset === 0 || members.isFetching}
              onClick={() =>
                setOffset(Math.max(0, offset - PRESET_MEMBER_PAGE_SIZE))
              }
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!members.data?.hasNext || members.isFetching}
              onClick={() => setOffset(offset + PRESET_MEMBER_PAGE_SIZE)}
            >
              Next
            </Button>
            {preview ? (
              <Button disabled={!canMutate} onClick={() => setReview(preview)}>
                Review recipe
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(review)}
        onOpenChange={(open) => !open && setReview(null)}
        title={`Review “${review?.label ?? "preset"}” in the builder?`}
        description={
          <span className="block space-y-2">
            <span className="block">
              No segment will be created yet. The builder will open with this
              recipe prefilled in the natural-language compiler. Generate it,
              review the exact rules, and save only when they are correct.
            </span>
            <span className="block rounded-md bg-muted p-3 text-sm">
              {review?.description}
            </span>
          </span>
        }
        confirmLabel="Open reviewed draft"
        confirmVariant="default"
        onConfirm={() => {
          if (review) goToBuilder(review);
        }}
      />
    </section>
  );
}

interface ComparisonRow {
  pnl?: Awaited<ReturnType<typeof compareSegmentPnL>>["items"][number];
  engagement?: Awaited<ReturnType<typeof getSegmentEngagementMetrics>>;
  growth?: Awaited<ReturnType<typeof getSegmentGrowthMetrics>>;
}

function PerformancePanel({ segments }: SegmentParitySuiteProps) {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [days, setDays] = React.useState(90);
  const [comparedDays, setComparedDays] = React.useState(90);
  const [rows, setRows] = React.useState<Map<string, ComparisonRow> | null>(
    null,
  );
  const [order, setOrder] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(false);
  const loadingRef = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const controller = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length < MAX_COMPARE_SEGMENTS
          ? [...current, id]
          : current,
    );
  async function compare() {
    if (
      selected.length < 2 ||
      selected.length > MAX_COMPARE_SEGMENTS ||
      loadingRef.current
    )
      return;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const ids = [...selected];
    const requestDays = days;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const [pnlResult, ...details] = await Promise.allSettled([
        compareSegmentPnL(ids, requestDays, next.signal),
        ...ids.flatMap((id) => [
          getSegmentEngagementMetrics(id, requestDays, next.signal),
          getSegmentGrowthMetrics(id, requestDays, next.signal),
        ]),
      ]);
      if (next.signal.aborted) return;
      if (pnlResult.status === "rejected") throw pnlResult.reason;
      const map = new Map<string, ComparisonRow>();
      for (const item of pnlResult.value.items)
        map.set(item.segmentId, { pnl: item });
      ids.forEach((id, index) => {
        const row = map.get(id) ?? {};
        const engagement = details[index * 2];
        const growth = details[index * 2 + 1];
        if (engagement?.status === "fulfilled")
          row.engagement = engagement.value as Awaited<
            ReturnType<typeof getSegmentEngagementMetrics>
          >;
        if (growth?.status === "fulfilled")
          row.growth = growth.value as Awaited<
            ReturnType<typeof getSegmentGrowthMetrics>
          >;
        map.set(id, row);
      });
      setRows(map);
      setOrder(ids);
      setComparedDays(requestDays);
    } catch (cause) {
      if (!next.signal.aborted) {
        setRows(null);
        setError(cause instanceof Error ? cause.message : "Comparison failed.");
      }
    } finally {
      loadingRef.current = false;
      if (!next.signal.aborted) setLoading(false);
    }
  }
  const nameFor = (id: string) =>
    segments.find((segment) => segment.id === id)?.name ?? id;
  return (
    <section className="rounded-xl border bg-card p-5">
      <PanelHeader
        icon={BarChart3}
        title="Performance comparison"
        description="Compare 2–5 segments across P&L, engagement, and growth."
      />
      <Button
        className="mt-4"
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={segments.length < 2}
      >
        Compare segments
      </Button>
      {segments.length < 2 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          At least two segments are required.
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!loadingRef.current) {
            setOpen(next);
            if (!next) controller.current?.abort();
          }
        }}
      >
        <DialogContent className="max-w-5xl" closeDisabled={loading}>
          <DialogHeader>
            <DialogTitle>Audience performance comparison</DialogTitle>
            <DialogDescription>
              Revenue is required for the comparison; engagement and growth
              failures degrade only their affected cells.
            </DialogDescription>
          </DialogHeader>
          <div aria-busy={loading} className="space-y-4">
            <fieldset>
              <legend className="text-sm font-medium">
                Segments to compare
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {segments.map((segment) => {
                  const checked = selected.includes(segment.id);
                  const capped =
                    !checked && selected.length >= MAX_COMPARE_SEGMENTS;
                  return (
                    <label
                      key={segment.id}
                      className="flex items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={loading || capped}
                        onChange={() => toggle(segment.id)}
                      />
                      {segment.name}
                    </label>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {selected.length}/{MAX_COMPARE_SEGMENTS} selected
              </p>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Window</span>
              {[30, 90, 365].map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  variant={days === choice ? "default" : "outline"}
                  aria-pressed={days === choice}
                  disabled={loading}
                  onClick={() => setDays(choice)}
                >
                  {choice}d
                </Button>
              ))}
              <Button
                className="ml-auto"
                disabled={selected.length < 2 || loading}
                onClick={() => void compare()}
              >
                {loading ? "Comparing…" : "Compare"}
              </Button>
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
              >
                <p>{error}</p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void compare()}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {rows && order.length ? (
              <ComparisonTable
                rows={rows}
                order={order}
                nameFor={nameFor}
                days={comparedDays}
              />
            ) : !loading && !error ? (
              <p className="text-sm text-muted-foreground">
                Choose two to five segments and run the comparison.
              </p>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ComparisonTable({
  rows,
  order,
  nameFor,
  days,
}: {
  rows: Map<string, ComparisonRow>;
  order: string[];
  nameFor: (id: string) => string;
  days: number;
}) {
  const money = (
    cents: number | null | undefined,
    currency: string | null | undefined,
  ) => {
    if (cents == null || !Number.isFinite(cents)) return "—";
    const amount = cents / 100;
    const code = currency?.trim().toUpperCase() ?? "";
    if (/^[A-Z]{3}$/u.test(code)) {
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: code,
        })
          .format(amount)
          .replace(/[  ]/gu, " ");
      } catch {
        // Unknown ISO-like code falls through to a labeled plain amount.
      }
    }
    const plain = amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return code ? `${code} ${plain}` : plain;
  };
  const rate = (value: number | undefined, sends: number | undefined) =>
    !sends || value == null ? "—" : `${(value * 100).toFixed(1)}%`;
  const growth = (row: ComparisonRow | undefined) =>
    !row?.growth || row.growth.snapshots < 2
      ? "—"
      : `${row.growth.delta > 0 ? "+" : ""}${row.growth.delta.toLocaleString()} (${row.growth.deltaPct > 0 ? "+" : ""}${row.growth.deltaPct.toFixed(1)}%)`;
  const metrics: Array<
    [string, (row: ComparisonRow | undefined) => React.ReactNode]
  > = [
    [
      "Members",
      (row) =>
        row?.pnl?.memberCount?.toLocaleString() ??
        row?.engagement?.memberCount?.toLocaleString() ??
        "—",
    ],
    ["Revenue", (row) => money(row?.pnl?.revenueCents, row?.pnl?.currency)],
    [
      "Revenue / recipient",
      (row) => money(row?.pnl?.revenuePerMemberCents, row?.pnl?.currency),
    ],
    [
      "Open rate",
      (row) => rate(row?.engagement?.openRate, row?.engagement?.sends),
    ],
    [
      "Click rate",
      (row) => rate(row?.engagement?.clickRate, row?.engagement?.sends),
    ],
    [
      "Unsubscribe rate",
      (row) => rate(row?.engagement?.unsubRate, row?.engagement?.sends),
    ],
    [`Growth (${days}d)`, growth],
  ];
  return (
    <div
      role="region"
      aria-label={`Segment performance comparison for ${days} days`}
      tabIndex={0}
      className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">
          Segment performance comparison for {days} days
        </caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className="px-3 py-2 text-left">
              Metric
            </th>
            {order.map((id) => (
              <th scope="col" key={id} className="px-3 py-2 text-left">
                {nameFor(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map(([label, render]) => (
            <tr key={label} className="border-b">
              <th
                scope="row"
                className="px-3 py-2 text-left font-medium text-muted-foreground"
              >
                {label}
              </th>
              {order.map((id) => (
                <td key={id} className="px-3 py-2 tabular-nums">
                  {render(rows.get(id))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        Rates show “—” without delivery-outcome events. Growth shows “—” until
        at least two snapshots exist.
      </p>
    </div>
  );
}

function SavedSegmentOrganizer({
  tenantId,
  role,
  identityReady,
  canMutate,
}: SegmentParitySuiteProps) {
  const client = useQueryClient();
  const savedKey = React.useMemo(
    () => base("saved-segment-bookmarks", tenantId, role),
    [tenantId, role],
  );
  const foldersKey = React.useMemo(
    () => base("saved-segment-folders", tenantId, role),
    [tenantId, role],
  );
  const saved = useQuery({
    queryKey: savedKey,
    enabled: identityReady,
    staleTime: STALE.list,
    queryFn: ({ signal }) => listSavedSegmentBookmarks(tenantId, signal),
  });
  const folders = useQuery({
    queryKey: foldersKey,
    enabled: identityReady,
    staleTime: STALE.list,
    queryFn: ({ signal }) => listStrictSegmentFolders(tenantId, signal),
  });
  const [busy, setBusy] = React.useState<Set<string>>(new Set());
  const busyRef = React.useRef<Set<string>>(new Set());
  const [previews, setPreviews] = React.useState<
    Map<string, SavedSegmentAggregatePreview>
  >(new Map());
  const [previewErrors, setPreviewErrors] = React.useState<Set<string>>(
    new Set(),
  );
  const [folderDialog, setFolderDialog] = React.useState<
    { mode: "create" } | { mode: "rename"; folder: StrictSegmentFolder } | null
  >(null);
  const [folderName, setFolderName] = React.useState("");
  const [folderSaving, setFolderSaving] = React.useState(false);
  const folderSavingRef = React.useRef(false);
  const rows = React.useMemo(
    () => (Array.isArray(saved.data?.items) ? saved.data.items : []),
    [saved.data?.items],
  );
  const folderRows = React.useMemo(
    () => (Array.isArray(folders.data) ? folders.data : []),
    [folders.data],
  );
  const pinned = React.useMemo(
    () =>
      rows
        .filter((row) => row.isPinned)
        .sort(
          (a, b) =>
            (a.pinOrder ?? Number.MAX_SAFE_INTEGER) -
            (b.pinOrder ?? Number.MAX_SAFE_INTEGER),
        ),
    [rows],
  );
  const markBusy = (id: string, value: boolean) => {
    const next = new Set(busyRef.current);
    if (value) next.add(id);
    else next.delete(id);
    busyRef.current = next;
    setBusy(next);
  };
  async function patch(
    row: SavedSegmentBookmark,
    changes: Parameters<typeof patchSavedSegmentBookmark>[1],
  ) {
    if (!canMutate || busyRef.current.has(row.id)) return;
    markBusy(row.id, true);
    try {
      await patchSavedSegmentBookmark(row.id, changes, tenantId);
      await client.invalidateQueries({ queryKey: savedKey });
      toast.success(`Updated “${row.name}”.`);
    } catch (cause) {
      await client.invalidateQueries({ queryKey: savedKey });
      toast.error(
        cause instanceof Error ? cause.message : "Saved segment update failed.",
      );
    } finally {
      markBusy(row.id, false);
    }
  }
  async function movePin(row: SavedSegmentBookmark, direction: -1 | 1) {
    const index = pinned.findIndex((item) => item.id === row.id);
    const other = pinned[index + direction];
    if (!other || busyRef.current.size) return;
    markBusy(row.id, true);
    markBusy(other.id, true);
    try {
      await patchSavedSegmentBookmark(
        row.id,
        { pinOrder: other.pinOrder ?? index + direction },
        tenantId,
      );
      await patchSavedSegmentBookmark(
        other.id,
        { pinOrder: row.pinOrder ?? index },
        tenantId,
      );
      toast.success("Pinned order updated.");
    } catch (cause) {
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Pinned order could not be updated.",
      );
    } finally {
      await client.invalidateQueries({ queryKey: savedKey });
      markBusy(row.id, false);
      markBusy(other.id, false);
    }
  }
  async function preview(row: SavedSegmentBookmark) {
    if (busyRef.current.has(row.id)) return;
    markBusy(row.id, true);
    setPreviewErrors((current) => {
      const next = new Set(current);
      next.delete(row.id);
      return next;
    });
    try {
      const value = await getSavedSegmentAggregatePreview(row.id);
      setPreviews((current) => new Map(current).set(row.id, value));
      await client.invalidateQueries({ queryKey: savedKey });
    } catch (cause) {
      setPreviewErrors((current) => new Set(current).add(row.id));
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Count could not be refreshed.",
      );
    } finally {
      markBusy(row.id, false);
    }
  }
  function openFolder(mode: "create" | "rename", folder?: StrictSegmentFolder) {
    setFolderName(folder?.name ?? "");
    setFolderDialog(mode === "create" ? { mode } : { mode, folder: folder! });
  }
  async function saveFolder() {
    if (!folderDialog || !canMutate || folderSavingRef.current) return;
    folderSavingRef.current = true;
    setFolderSaving(true);
    try {
      if (folderDialog.mode === "create")
        await createStrictSegmentFolder(folderName, tenantId);
      else
        await renameStrictSegmentFolder(
          folderDialog.folder.id,
          folderName,
          tenantId,
        );
      await client.invalidateQueries({ queryKey: foldersKey });
      setFolderDialog(null);
      toast.success(
        folderDialog.mode === "create" ? "Folder created." : "Folder renamed.",
      );
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : "Folder update failed.",
      );
    } finally {
      folderSavingRef.current = false;
      setFolderSaving(false);
    }
  }
  async function removeFolder(folder: StrictSegmentFolder) {
    await deleteStrictSegmentFolder(folder.id);
    await Promise.all([
      client.invalidateQueries({ queryKey: foldersKey }),
      client.invalidateQueries({ queryKey: savedKey }),
    ]);
    toast.success(
      `Deleted “${folder.name}”. Its saved segments are now unfiled.`,
    );
  }
  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PanelHeader
          icon={Bookmark}
          title="Saved-segment organizer"
          description="Pin and order reusable views, control sharing, and file them into folders."
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!canMutate}
          onClick={() => openFolder("create")}
        >
          <FolderPlus className="h-4 w-4" /> New folder
        </Button>
      </div>
      {!canMutate ? <ReadOnlyNotice /> : null}
      {folders.isLoading || saved.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground" aria-busy="true">
          Loading saved segments and folders…
        </p>
      ) : null}
      {folders.isError ? (
        <div role="alert" className="mt-4">
          <p className="text-sm text-destructive">
            Folders could not be loaded. Saved segments remain available below.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void folders.refetch()}
          >
            Retry folders
          </Button>
        </div>
      ) : null}
      {saved.isError ? (
        <div role="alert" className="mt-4">
          <p className="text-sm text-destructive">
            Saved segments could not be loaded.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => void saved.refetch()}
          >
            Retry saved segments
          </Button>
        </div>
      ) : null}
      {folders.isSuccess ? (
        <div
          className="mt-4 flex flex-wrap gap-2"
          aria-label="Saved segment folders"
        >
          {folderRows.length === 0 ? (
            <span className="text-sm text-muted-foreground">
              No folders yet.
            </span>
          ) : (
            folderRows.map((folder) => (
              <span
                key={folder.id}
                className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm"
              >
                {folder.name}
                {canMutate ? (
                  <>
                    <button
                      type="button"
                      className="rounded px-1 text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => openFolder("rename", folder)}
                      aria-label={`Rename ${folder.name}`}
                    >
                      Rename
                    </button>
                    <ConfirmDialog
                      title={`Delete “${folder.name}”?`}
                      description="The folder will be deleted. Saved segments in it will be moved to Unfiled; no saved segment is deleted."
                      confirmLabel="Delete folder"
                      onConfirm={() => removeFolder(folder)}
                      trigger={
                        <button
                          type="button"
                          className="rounded px-1 text-xs text-destructive underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`Delete ${folder.name}`}
                        >
                          Delete
                        </button>
                      }
                    />
                  </>
                ) : null}
              </span>
            ))
          )}
        </div>
      ) : null}
      {saved.isSuccess && rows.length === 0 ? (
        <p className="mt-5 text-sm text-muted-foreground">
          No saved-segment bookmarks have been created. This is a verified empty
          library.
        </p>
      ) : null}
      {saved.isSuccess && rows.length > 0 ? (
        <div className="mt-5 space-y-3">
          {rows.map((row) => {
            const pinIndex = pinned.findIndex((item) => item.id === row.id);
            const previewValue = previews.get(row.id);
            const rowBusy = busy.has(row.id);
            return (
              <article
                key={row.id}
                className="rounded-lg border p-4"
                aria-busy={rowBusy}
              >
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-medium">{row.name}</h3>
                    {row.description ? (
                      <p className="truncate text-sm text-muted-foreground">
                        {row.description}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {previewValue
                        ? `${previewValue.count.toLocaleString()} members · ${previewValue.workspacePercentage.toFixed(1)}% of workspace · refreshed ${new Date(previewValue.generatedAt).toLocaleString()}`
                        : row.lastCount != null
                          ? `${row.lastCount.toLocaleString()} members${row.lastEvaluatedAt ? ` · last evaluated ${new Date(row.lastEvaluatedAt).toLocaleString()}` : ""}`
                          : "Never evaluated"}
                    </p>
                    {previewErrors.has(row.id) ? (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        Count refresh failed. Retry is available.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rowBusy}
                      onClick={() => void preview(row)}
                    >
                      {rowBusy
                        ? "Working…"
                        : previewErrors.has(row.id)
                          ? "Retry count"
                          : "Refresh count"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canMutate || rowBusy}
                      aria-pressed={row.isPinned}
                      onClick={() =>
                        void patch(
                          row,
                          row.isPinned
                            ? { isPinned: false }
                            : { isPinned: true, pinOrder: pinned.length },
                        )
                      }
                    >
                      {row.isPinned ? "Unpin" : "Pin"}
                    </Button>
                    {row.isPinned ? (
                      <>
                        <Button
                          size="icon"
                          variant="outline"
                          aria-label={`Move ${row.name} up`}
                          disabled={!canMutate || rowBusy || pinIndex <= 0}
                          onClick={() => void movePin(row, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="outline"
                          aria-label={`Move ${row.name} down`}
                          disabled={
                            !canMutate ||
                            rowBusy ||
                            pinIndex < 0 ||
                            pinIndex >= pinned.length - 1
                          }
                          onClick={() => void movePin(row, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </>
                    ) : null}
                    <Label className="sr-only" htmlFor={`scope-${row.id}`}>
                      Sharing for {row.name}
                    </Label>
                    <select
                      id={`scope-${row.id}`}
                      aria-label={`Sharing for ${row.name}`}
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      disabled={!canMutate || rowBusy}
                      value={row.visibilityScope}
                      onChange={(e) =>
                        void patch(row, {
                          visibilityScope: e.target.value as
                            | "personal"
                            | "workspace",
                        })
                      }
                    >
                      <option value="personal">Personal</option>
                      <option value="workspace">Workspace</option>
                    </select>
                    <Label className="sr-only" htmlFor={`folder-${row.id}`}>
                      Folder for {row.name}
                    </Label>
                    <select
                      id={`folder-${row.id}`}
                      aria-label={`Folder for ${row.name}`}
                      className="h-9 max-w-44 rounded-md border bg-background px-2 text-sm"
                      disabled={!canMutate || rowBusy || folders.isError}
                      value={row.folderId ?? ""}
                      onChange={(e) =>
                        void patch(row, { folderId: e.target.value || null })
                      }
                    >
                      <option value="">Unfiled</option>
                      {folderRows.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </article>
            );
          })}
          <p className="text-xs text-muted-foreground">
            {rows.length.toLocaleString()} visible ·{" "}
            {saved.data.totalItems.toLocaleString()} workspace total · limit{" "}
            {saved.data.maxItems.toLocaleString()}
          </p>
        </div>
      ) : null}
      <Dialog
        open={Boolean(folderDialog)}
        onOpenChange={(open) =>
          !open && !folderSavingRef.current && setFolderDialog(null)
        }
      >
        <DialogContent closeDisabled={folderSaving}>
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.mode === "rename"
                ? "Rename folder"
                : "Create folder"}
            </DialogTitle>
            <DialogDescription>
              Folders organize reusable saved-segment bookmarks without changing
              their predicates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="saved-folder-name">Folder name</Label>
            <Input
              id="saved-folder-name"
              maxLength={120}
              autoFocus
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveFolder();
                }
              }}
              disabled={folderSaving}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFolderDialog(null)}
              disabled={folderSaving}
            >
              Cancel
            </Button>
            <Button
              disabled={!folderName.trim() || folderSaving}
              onClick={() => void saveFolder()}
            >
              {folderSaving ? "Saving…" : "Save folder"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
