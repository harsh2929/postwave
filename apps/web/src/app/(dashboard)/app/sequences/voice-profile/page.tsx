// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";

// The voice API module is only needed once a handler runs, so it is imported
// at the call sites and stays out of the route's eager chunk (bundle budget).
// One shared promise so concurrent handlers never race two import() calls.
let voiceApiModule: Promise<typeof import("@/lib/voice-api")> | undefined;
const voiceApi = () => (voiceApiModule ??= import("@/lib/voice-api"));
import type {
  AddSourceParams,
  VoiceProfile,
  VoiceSource,
} from "@/lib/voice-types";
import { isProfileStale } from "@/lib/sequence-helpers";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/relative-time";

import { AddSourceDialog } from "./add-source-dialog";
import { VoiceSourcesCard } from "./voice-sources-card";

/** Short plain-language explanation for each stylistic metric (SEQ-053). */
const STYLISTIC_HELP: Record<string, string> = {
  sentence_len: "How long your sentences run, relative to a baseline corpus.",
  sentence_variance: "How much your sentence length varies for rhythm.",
  paragraph_len: "How long your paragraphs tend to be.",
  formality: "How formal vs. conversational your register is.",
  hedging: "How often you soften claims (‘maybe’, ‘I think’).",
  passive_voice: "How often you use the passive voice.",
};

export default function VoiceProfilePage() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [sources, setSources] = useState<VoiceSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const buildingRef = useRef(false);
  const [addOpen, setAddOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when the user changes sources so we know the profile no longer
  // reflects the latest material even before the timestamps update (SEQ-037).
  const [dirtiedSinceBuild, setDirtiedSinceBuild] = useState(false);

  const [sampleTopic, setSampleTopic] = useState("");
  const [sample, setSample] = useState<string | null>(null);
  const [sampling, setSampling] = useState(false);
  const samplingRef = useRef(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { getProfile, listSources } = await voiceApi();
    const [profileResult, sourcesResult] = await Promise.allSettled([
      getProfile(),
      listSources(),
    ]);
    const errors: string[] = [];
    if (profileResult.status === "fulfilled") setProfile(profileResult.value);
    else
      errors.push(
        profileResult.reason instanceof Error
          ? profileResult.reason.message
          : "Voice profile could not be loaded.",
      );
    if (sourcesResult.status === "fulfilled") setSources(sourcesResult.value);
    else
      errors.push(
        sourcesResult.reason instanceof Error
          ? sourcesResult.reason.message
          : "Voice sources could not be loaded.",
      );
    setLoadError(errors.join(" ") || null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const onRebuild = async () => {
    if (buildingRef.current || loading) return;
    buildingRef.current = true;
    setBuilding(true);
    try {
      const { buildProfile } = await voiceApi();
      const p = await buildProfile();
      setProfile(p);
      setDirtiedSinceBuild(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Could not build the voice profile.",
      );
    } finally {
      buildingRef.current = false;
      setBuilding(false);
    }
  };

  const onAddSource = async (params: AddSourceParams) => {
    const { addSource } = await voiceApi();
    const next = await addSource(params);
    setSources((curr) => [...curr, next]);
    setDirtiedSinceBuild(true);
    setAddOpen(false);
  };

  const onIngest = async (id: string) => {
    setSources((current) =>
      current.map((source) =>
        source.id === id ? { ...source, status: "ingesting" } : source,
      ),
    );
    try {
      const { ingestSource } = await voiceApi();
      const next = await ingestSource(id);
      setSources((curr) => curr.map((s) => (s.id === id ? next : s)));
      setDirtiedSinceBuild(true);
      toast.success("Source ingest completed.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not re-ingest that source.",
      );
      setSources((current) =>
        current.map((source) =>
          source.id === id ? { ...source, status: "error" } : source,
        ),
      );
    }
  };

  const onRemove = async (id: string) => {
    try {
      const { removeSource } = await voiceApi();
      await removeSource(id);
      setSources((curr) => curr.filter((s) => s.id !== id));
      setDirtiedSinceBuild(true);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove that source.",
      );
    }
  };

  const onTryIt = async () => {
    if (samplingRef.current) return;
    samplingRef.current = true;
    setSampling(true);
    try {
      const { generateVoiceSample } = await voiceApi();
      setSample(await generateVoiceSample(sampleTopic));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not generate a sample.",
      );
    } finally {
      samplingRef.current = false;
      setSampling(false);
    }
  };

  const stale =
    !!profile &&
    (dirtiedSinceBuild || isProfileStale(profile.builtAt, sources));

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-6 px-4 py-5 sm:space-y-8 sm:px-6 sm:py-6 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Voice profile
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The quiet engine behind every generated email. Feed it your best
            writing - Moosewave does the rest.
          </p>
          {profile ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Built from {profile.itemCount} items ·{" "}
              <RelativeTime iso={profile.builtAt} />
            </p>
          ) : null}
          {profile?.itemCount === 0 ? (
            <p className="mt-2 text-sm font-medium text-warning-emphasis">
              This profile contains no analysed source material yet.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {profile ? (
            <Badge variant={stale ? "warning" : "success"}>
              {stale ? "Update available" : profile.status}
            </Badge>
          ) : null}
          <Tooltip
            label={
              profile
                ? `Re-analyze ${sources.length} source${sources.length === 1 ? "" : "s"} to refresh the profile`
                : "Analyze your sources to build the profile"
            }
            side="bottom"
            className="right-0 left-auto max-w-[min(18rem,calc(100vw-2rem))] translate-x-0 whitespace-normal [&[aria-hidden=true]]:hidden"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onRebuild()}
              disabled={building || loading}
            >
              {building ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Re-analyzing {sources.length}…
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" />
                  {profile ? "Rebuild profile" : "Build profile"}
                </>
              )}
            </Button>
          </Tooltip>
        </div>
      </header>

      {loadError ? (
        <div
          role="alert"
          className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-foreground"
        >
          <p>{loadError} Existing data has been kept where it was available.</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {stale ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning-subtle bg-warning-subtle/40 px-4 py-3 text-sm">
          <span className="text-warning-emphasis">
            You&apos;ve added or re-ingested material since this profile was
            built. Rebuild to fold it in.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onRebuild()}
            disabled={building}
          >
            Rebuild now
          </Button>
        </div>
      ) : null}

      <VoiceSourcesCard
        loading={loading}
        onAddClick={() => setAddOpen(true)}
        onIngest={(sourceId) => void onIngest(sourceId)}
        onRemove={(sourceId) => void onRemove(sourceId)}
        sources={sources}
      />

      {profile && (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardContent className="space-y-4 p-4 sm:p-6">
                <h2 className="font-medium">Stylistic features</h2>
                <p className="text-xs text-muted-foreground">
                  Each score is 0–100 relative to a baseline corpus.
                </p>
                <StylisticBars profile={profile} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 p-4 sm:p-6">
                <h2 className="font-medium">Tonal vector</h2>
                <TonalRadar profile={profile} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 p-4 sm:p-6">
                <h2 className="font-medium">Distinctive vocabulary</h2>
                <VocabCloud profile={profile} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 p-4 sm:p-6">
                <h2 className="font-medium">Representative samples</h2>
                <SamplesAccordion profile={profile} />
              </CardContent>
            </Card>
          </div>

          {/* Try it: sanity-check the profile before generating a whole
              sequence with it (SEQ-047). */}
          <Card>
            <CardContent className="space-y-3 p-4 sm:p-6">
              <h2 className="font-medium">Try it in your voice</h2>
              <p className="text-sm text-muted-foreground">
                Generate a quick paragraph to check the profile sounds like you
                before you build a sequence.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={sampleTopic}
                  onChange={(e) => setSampleTopic(e.target.value)}
                  placeholder="Optional topic — e.g. announcing a price change"
                  aria-label="Sample topic"
                />
                <Button
                  onClick={() => void onTryIt()}
                  disabled={sampling}
                  className="shrink-0"
                >
                  {sampling ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  {sampling ? "Writing…" : "Generate sample"}
                </Button>
              </div>
              {sample ? (
                <p className="rounded-md border bg-muted/30 p-4 text-sm leading-relaxed">
                  {sample}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Forward path out of the profile (SEQ-057). */}
          <div className="flex justify-end">
            <Button asChild>
              <Link href="/app/sequences/new">
                <Sparkles className="h-4 w-4" />
                Generate a sequence in this voice
              </Link>
            </Button>
          </div>
        </>
      )}

      <AddSourceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={onAddSource}
      />
    </div>
  );
}

function StylisticBars({ profile }: { profile: VoiceProfile }) {
  if (profile.stylistic.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No stylistic measurements are available yet.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {profile.stylistic.map((f) => {
        const help = STYLISTIC_HELP[f.key];
        const value = Math.round(f.weight * 100);
        return (
          <li key={f.key} className="flex items-center gap-3">
            {help ? (
              <Tooltip label={help} className="[&[aria-hidden=true]]:hidden">
                <span
                  tabIndex={0}
                  className="w-40 cursor-help truncate rounded-sm text-sm underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  {f.label}
                </span>
              </Tooltip>
            ) : (
              <span className="w-40 truncate text-sm">{f.label}</span>
            )}
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-foreground"
                style={{ width: `${value}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {value} / 100
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TonalRadar({ profile }: { profile: VoiceProfile }) {
  const size = 240;
  // Pad the viewBox so axis labels near the edge are never clipped (SEQ-030).
  const pad = 44;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 24;
  const axes = profile.tonal;
  if (axes.length < 3) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough tonal dimensions are available to draw a meaningful radar.
      </p>
    );
  }
  const n = axes.length;
  const points = axes.map((a, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const mag = (a.value + 1) / 2;
    const x = cx + Math.cos(angle) * r * mag;
    const y = cy + Math.sin(angle) * r * mag;
    return { x, y, angle, label: a.label };
  });
  const polygon = points.map((p) => `${p.x},${p.y}`).join(" ");
  const summary = axes
    .map((a) => `${a.label} ${a.value.toFixed(2)}`)
    .join("; ");
  return (
    <svg
      viewBox={`${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}`}
      className="mx-auto w-full max-w-[300px]"
      role="img"
      aria-label={`Tonal vector radar. ${summary}.`}
    >
      {[0.25, 0.5, 0.75, 1].map((s) => (
        <circle
          key={s}
          cx={cx}
          cy={cy}
          r={r * s}
          fill="none"
          stroke="currentColor"
          className="text-muted"
          strokeWidth={1}
        />
      ))}
      {points.map((p, i) => {
        const cos = Math.cos(p.angle);
        const labelX = cx + cos * (r + 14);
        const labelY = cy + Math.sin(p.angle) * (r + 14);
        // Anchor by quadrant so labels grow outward, away from the box edge.
        const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
        return (
          <g key={i}>
            <line
              x1={cx}
              y1={cy}
              x2={cx + cos * r}
              y2={cy + Math.sin(p.angle) * r}
              stroke="currentColor"
              className="text-muted"
              strokeWidth={1}
            />
            <text
              x={labelX}
              y={labelY}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="fill-current text-[9px] text-muted-foreground"
            >
              {p.label}
            </text>
          </g>
        );
      })}
      <polygon
        points={polygon}
        fill="currentColor"
        className="text-foreground/15 stroke-current"
        strokeWidth={1.5}
      />
    </svg>
  );
}

function VocabCloud({ profile }: { profile: VoiceProfile }) {
  const sorted = [...profile.vocabulary].sort((a, b) => b.weight - a.weight);
  if (sorted.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No distinctive vocabulary has been identified yet.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {sorted.map((v) => {
        const size = 0.85 + v.weight * 0.45;
        return (
          <Tooltip
            key={v.term}
            label={`Distinctiveness ${Math.round(v.weight * 100)} / 100`}
            className="[&[aria-hidden=true]]:hidden"
          >
            <span
              tabIndex={0}
              className="inline-flex min-h-8 cursor-help items-center rounded-full border bg-muted/40 px-2.5 py-1 leading-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              style={{ fontSize: `${size}rem` }}
            >
              {v.term}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

function SamplesAccordion({ profile }: { profile: VoiceProfile }) {
  const [open, setOpen] = useState<string | null>(null);
  if (profile.samples.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No representative samples are available yet.
      </p>
    );
  }
  return (
    <ul className="divide-y border rounded-md">
      {profile.samples.map((s, index) => {
        const contentId = `voice-sample-${index}`;
        return (
          <li key={s.id} className="px-3 py-2.5">
            <button
              type="button"
              onClick={() => setOpen((o) => (o === s.id ? null : s.id))}
              aria-expanded={open === s.id}
              aria-controls={contentId}
              className="min-h-8 w-full rounded text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{s.title}</span>
                <Badge variant="outline" className="shrink-0">
                  {s.sourceLabel}
                </Badge>
              </div>
            </button>
            {open === s.id && (
              <div id={contentId} className="mt-2 space-y-2">
                {/* SEQ-059: expand to the FULL sample text, not just the excerpt. */}
                <p className="text-sm text-muted-foreground whitespace-pre-line">
                  {s.text || s.excerpt}
                </p>
                {s.sourceUrl ? (
                  <a
                    href={s.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-8 items-center text-xs text-primary hover:underline"
                  >
                    View source ↗
                  </a>
                ) : null}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
