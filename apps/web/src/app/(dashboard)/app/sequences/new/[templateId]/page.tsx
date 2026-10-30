// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { createSequence, getProfile, getTemplate } from "@/lib/voice-api";
import type {
  SequenceTemplate,
  StyleControls,
  VoiceProfile,
} from "@/lib/voice-types";
import { asRoute } from "@/lib/typed-routes";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/relative-time";

type Step = 1 | 2 | 3;
type ProfileLoadState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "ready"; profile: VoiceProfile };

const DEFAULT_STYLE: StyleControls = {
  humor: 0,
  directness: 0.3,
  lengthBias: 0,
  formality: -0.2,
};

function clampStep(raw: string | null): Step {
  const n = Number(raw);
  return n === 2 ? 2 : n === 3 ? 3 : 1;
}

export default function NewSequenceFlowPage() {
  const params = useParams<{ templateId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Draft inputs are persisted per-template so a refresh (or coming back to
  // tweak variables — SEQ-040) restores them instead of resetting to blank.
  const storageKey = `postwave:seq-new:${params.templateId}`;

  const [template, setTemplate] = useState<SequenceTemplate | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const [profileState, setProfileState] = useState<ProfileLoadState>({
    kind: "loading",
  });
  const [profileAttempt, setProfileAttempt] = useState(0);

  // Step lives in the URL so Back/refresh move between steps (SEQ-019).
  const step = clampStep(searchParams.get("step"));
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [style, setStyle] = useState<StyleControls>(DEFAULT_STYLE);
  const [attempted, setAttempted] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genMessage, setGenMessage] = useState<string>("");
  const [genError, setGenError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const goToStep = (next: Step) => {
    const q = new URLSearchParams(searchParams.toString());
    q.set("step", String(next));
    // push (not replace) so browser Back returns to the previous step.
    router.push(asRoute(`${pathname}?${q.toString()}`));
  };

  useEffect(() => {
    // Guards both fetches against a templateId change (and unmount) landing a
    // superseded template's variables over the current one.
    let active = true;
    setTemplate(null);
    setTemplateError(null);
    void getTemplate(params.templateId)
      .then((t) => {
        if (!active) return;
        setTemplate(t);
        setVariables((prev) => {
          const seed: Record<string, string> = {};
          t.variables.forEach((v) => (seed[v.key] = prev[v.key] ?? ""));
          return seed;
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setTemplateError(
          err instanceof Error ? err.message : "Could not load template",
        );
      });

    return () => {
      active = false;
    };
  }, [params.templateId]);

  useEffect(() => {
    let active = true;
    setProfileState({ kind: "loading" });
    void getProfile()
      .then((profile) => {
        if (!active) return;
        setProfileState(
          profile ? { kind: "ready", profile } : { kind: "missing" },
        );
      })
      .catch(() => {
        if (active) setProfileState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [profileAttempt]);

  // Restore persisted inputs once on mount.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          variables?: Record<string, string>;
          style?: StyleControls;
        };
        if (parsed.variables) setVariables(parsed.variables);
        if (parsed.style) setStyle(parsed.style);
      }
    } catch {
      /* ignore malformed drafts */
    }
    hydratedRef.current = true;
  }, [storageKey]);

  // Persist inputs on change.
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({ variables, style }),
      );
    } catch {
      /* best-effort */
    }
  }, [variables, style, storageKey]);

  const missingRequired = useMemo(() => {
    if (!template) return [];
    return template.variables
      .filter((v) => v.required && !variables[v.key]?.trim())
      .map((v) => v.label);
  }, [template, variables]);
  const variablesValid = missingRequired.length === 0;

  const generate = async () => {
    // The wizard step is a URL parameter (Back/Forward, bookmarks), so step 3
    // is reachable without step 1's Continue ever having validated. Re-check
    // here rather than spending a long generation on an ungrounded brief or
    // letting the server 422 after the spinner has run.
    if (!variablesValid) {
      setAttempted(true);
      goToStep(1);
      toast.error(
        `Generation needs every required variable. Still needed: ${missingRequired.join(", ")}.`,
      );
      return;
    }
    setGenerating(true);
    setGenMessage("Submitting…");
    setGenError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const sequence = await createSequence(
        {
          templateId: template!.id,
          variables,
          style,
        },
        {
          signal: controller.signal,
          onStatus: (status) => setGenMessage(status.message),
        },
      );
      setGenMessage("Drafts ready.");
      // SEQ-040: keep the per-template draft so "Re-run with different
      // variables" from the sequence detail lands here pre-filled with the
      // inputs that produced this draft. It's a per-template, session-scoped
      // copy (auto-saved on change), so a fresh start still shows prior inputs
      // to tweak rather than a blank form.
      router.push(`/app/sequences/${sequence.id}`);
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        controller.signal.aborted
      ) {
        setGenerating(false);
        setGenMessage("");
        toast.message("Generation cancelled.");
        return;
      }
      const message = err instanceof Error ? err.message : "Generation failed";
      setGenerating(false);
      setGenMessage("");
      setGenError(message);
      toast.error(message);
    } finally {
      abortRef.current = null;
    }
  };

  const cancelGeneration = () => {
    abortRef.current?.abort();
  };

  if (templateError) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-2 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
        <h1 className="text-xl font-semibold">
          Couldn&apos;t load sequence template
        </h1>
        <p role="alert" className="text-sm text-muted-foreground">
          {templateError}
        </p>
        <Button asChild variant="link" className="mt-2 px-0">
          <Link href="/app/sequences/new">← Back to templates</Link>
        </Button>
      </div>
    );
  }

  if (!template) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-5 text-sm text-muted-foreground sm:px-6 sm:py-6 md:p-8">
        Loading template…
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 md:p-8">
      <Button asChild variant="link" className="px-0">
        <Link href="/app/sequences/new">
          <ArrowLeft className="h-4 w-4" />
          All templates
        </Link>
      </Button>

      <header className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{template.category}</Badge>
          <span>{template.length} emails</span>
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {template.name}
        </h1>
        <p className="text-sm text-muted-foreground">{template.description}</p>
      </header>

      <Stepper step={step} />

      {step === 1 && (
        <Card>
          <CardContent className="p-6 space-y-5">
            <h2 className="font-medium">Variables</h2>
            <p className="text-sm text-muted-foreground -mt-2">
              The model uses these to ground every email.
            </p>
            {template.variables.map((v) => {
              const empty = !variables[v.key]?.trim();
              const showError = attempted && v.required && empty;
              return (
                <div key={v.key} className="space-y-1.5">
                  <Label htmlFor={v.key}>
                    {v.label}
                    {v.required && (
                      <span className="text-destructive ml-1">*</span>
                    )}
                  </Label>
                  <p
                    id={`${v.key}-description`}
                    className="text-xs text-muted-foreground"
                  >
                    {v.description}
                  </p>
                  {v.type === "longtext" ? (
                    <Textarea
                      id={v.key}
                      value={variables[v.key] ?? ""}
                      onChange={(e) =>
                        setVariables((p) => ({ ...p, [v.key]: e.target.value }))
                      }
                      placeholder={v.example}
                      rows={3}
                      aria-invalid={showError}
                      aria-describedby={`${v.key}-description${
                        showError ? ` ${v.key}-error` : ""
                      }`}
                    />
                  ) : (
                    <Input
                      id={v.key}
                      type={
                        v.type === "number"
                          ? "number"
                          : v.type === "url"
                            ? "url"
                            : "text"
                      }
                      value={variables[v.key] ?? ""}
                      onChange={(e) =>
                        setVariables((p) => ({ ...p, [v.key]: e.target.value }))
                      }
                      placeholder={v.example}
                      aria-invalid={showError}
                      aria-describedby={`${v.key}-description${
                        showError ? ` ${v.key}-error` : ""
                      }`}
                    />
                  )}
                  {showError ? (
                    <p
                      id={`${v.key}-error`}
                      className="text-xs text-destructive"
                    >
                      {v.label} is required.
                    </p>
                  ) : null}
                </div>
              );
            })}
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={() => {
                  if (!variablesValid) {
                    setAttempted(true);
                    const firstMissing = template.variables.find(
                      (variable) =>
                        variable.required && !variables[variable.key]?.trim(),
                    );
                    if (firstMissing) {
                      document.getElementById(firstMissing.key)?.focus();
                    }
                    return;
                  }
                  goToStep(2);
                }}
                aria-describedby={
                  !variablesValid && attempted
                    ? "sequence-variables-required-error"
                    : undefined
                }
                title={
                  variablesValid
                    ? undefined
                    : `Fill in: ${missingRequired.join(", ")}`
                }
              >
                Continue <ArrowRight className="h-4 w-4" />
              </Button>
              {!variablesValid && attempted ? (
                <p
                  id="sequence-variables-required-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  Still needed: {missingRequired.join(", ")}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <div>
              <h2 className="font-medium">Style controls</h2>
              <p className="text-sm text-muted-foreground">
                Nudge the generated drafts. These layer on top of your voice
                profile — they don&apos;t replace it.
              </p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <Slider
                label="Humor"
                value={style.humor}
                onChange={(v) => setStyle((s) => ({ ...s, humor: v }))}
                leftLabel="serious"
                rightLabel="playful"
              />
              <Slider
                label="Directness"
                value={style.directness}
                onChange={(v) => setStyle((s) => ({ ...s, directness: v }))}
                leftLabel="meandering"
                rightLabel="direct"
              />
              <Slider
                label="Length"
                value={style.lengthBias}
                onChange={(v) => setStyle((s) => ({ ...s, lengthBias: v }))}
                leftLabel="tight"
                rightLabel="long-form"
              />
              <Slider
                label="Formality"
                value={style.formality}
                onChange={(v) => setStyle((s) => ({ ...s, formality: v }))}
                leftLabel="casual"
                rightLabel="formal"
              />
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => goToStep(1)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <Button onClick={() => goToStep(3)}>
                Continue <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <Card>
          <CardContent className="p-6 space-y-6">
            <div>
              <h2 className="font-medium">Voice profile</h2>
              <p className="text-sm text-muted-foreground">
                Read-only summary. Moosewave grounds every draft in this profile.
              </p>
            </div>

            {profileState.kind === "missing" ? (
              <div className="rounded-md border bg-muted/40 p-4 text-sm space-y-2">
                <p className="font-medium">No voice profile yet.</p>
                <p className="text-muted-foreground">
                  Add at least one source so the generator can ground every
                  draft in your voice. You can still generate without one — it
                  will fall back to a neutral house style.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/app/sequences/voice-profile">
                    Set up voice profile
                  </Link>
                </Button>
              </div>
            ) : profileState.kind === "ready" ? (
              <div className="rounded-md border bg-muted/30 p-4 text-sm space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Profile ready</span>
                  <span className="text-xs text-muted-foreground">
                    {profileState.profile.itemCount} items, built{" "}
                    <RelativeTime iso={profileState.profile.builtAt} />
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {profileState.profile.vocabulary.slice(0, 8).map((v) => (
                    <span
                      key={v.term}
                      className="inline-flex items-center rounded-full border bg-background px-2 py-0.5 text-xs"
                    >
                      {v.term}
                    </span>
                  ))}
                </div>
              </div>
            ) : profileState.kind === "error" ? (
              <div
                role="alert"
                className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
              >
                <div>
                  <p className="font-medium">
                    Voice profile could not be verified.
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    The profile request failed, so this is not being treated as
                    a missing profile or a confirmed neutral-style fallback.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setProfileAttempt((value) => value + 1)}
                >
                  Retry profile
                </Button>
              </div>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                Loading profile…
              </p>
            )}

            {genError && !generating && (
              <div
                role="alert"
                className="flex items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive-emphasis"
              >
                <p className="min-w-0">{genError}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void generate()}
                >
                  Retry
                </Button>
              </div>
            )}

            {!variablesValid ? (
              <div
                id="sequence-step3-missing"
                role="alert"
                className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
              >
                <p className="min-w-0">
                  Generation needs every required variable. Still needed:{" "}
                  {missingRequired.join(", ")}.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => goToStep(1)}
                >
                  Fill variables
                </Button>
              </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Button
                variant="ghost"
                onClick={() => goToStep(2)}
                disabled={generating}
              >
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {generating ? (
                  <Button variant="outline" onClick={cancelGeneration}>
                    Cancel
                  </Button>
                ) : null}
                <Button
                  onClick={() => void generate()}
                  disabled={generating || !variablesValid}
                  aria-describedby={
                    variablesValid ? undefined : "sequence-step3-missing"
                  }
                  title={
                    variablesValid
                      ? undefined
                      : `Fill in: ${missingRequired.join(", ")}`
                  }
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {genMessage || "Generating…"}
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      {genError ? "Try again" : "Generate sequence"}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const items = [
    { n: 1, label: "Variables" },
    { n: 2, label: "Style" },
    { n: 3, label: "Profile" },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs text-muted-foreground">
      {items.map((it, i) => {
        const active = step === it.n;
        const done = step > it.n;
        return (
          <li key={it.n} className="flex items-center gap-2">
            <span
              className={`h-5 w-5 rounded-full inline-flex items-center justify-center text-[10px] font-bold border ${
                active
                  ? "bg-foreground text-background border-foreground"
                  : done
                    ? "border-transparent bg-success-subtle text-success-emphasis"
                    : "bg-background"
              }`}
            >
              {it.n}
            </span>
            <span className={active ? "text-foreground font-medium" : ""}>
              {it.label}
            </span>
            {i < items.length - 1 && <span className="opacity-50">→</span>}
          </li>
        );
      })}
    </ol>
  );
}
