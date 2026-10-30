// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * OnboardingChecklist — the stateful getting-started checklist.
 *
 * Replaces the dashboard's static three-card block. Fetches the tenant's real
 * progress from `GET /api/v1/onboarding-progress`, then renders the canonical
 * `CHECKLIST_GOALS` with live checkmarks, an animated SVG progress ring, a
 * tiered layout (the path-to-first-send spine is heroed; hardening goals are
 * recessed), and an all-done confetti celebration.
 *
 * Content contract: labels/descriptions prefer the SERVER-authored copy from
 * the progress payload, falling back to the shared schema's fallbacks.
 *
 * DISMISSAL IS A DECISION, AND A DECISION BELONGS TO THE PERSON. Whether a
 * step is DONE is derived server-side from real rows and cannot be written by
 * a client. Whether someone wants to SEE this card is the opposite: nothing
 * can derive it, so it has to be recorded. It used to be recorded nowhere on
 * web — there was no dismiss control at all, and a dismissal made on the phone
 * or the desktop app was invisible here, so the card stayed forever. Both
 * halves now go through `GET/PUT /api/v1/onboarding/steps`, the same
 * per-(tenant, user, step) row mobile and desktop write.
 *
 * Motion is token-sourced from `@postwave/design-tokens` (`motion`), reduced-
 * motion aware. Analytics fire via the app's existing PostHog `track` fn using
 * the canonical `EVENTS.ONBOARDING_*` names + `@postwave/onboarding-schema`
 * property shapes (platform: "web").
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion as anim, useReducedMotion } from "motion/react";
import { Check, X } from "lucide-react";

import { motion as tokens } from "@postwave/design-tokens";
import { EVENTS } from "@postwave/telemetry";
import {
  CHECKLIST_DECISION_STEP_KEY,
  CHECKLIST_GOALS,
  isOnboardingProgress,
  surfaceIsDecidedAway,
  type ChecklistGoal,
  type OnboardingProgress,
  type OnboardingRouteKey,
  type OnboardingEventProps,
} from "@postwave/onboarding-schema";

import { api } from "@/lib/api";
import {
  onboardingAuthorityReady,
  onboardingProgressKey,
} from "@/lib/onboarding-authority";
import type { RoleKey } from "@/lib/query-keys";
import { track } from "@/lib/telemetry";
import { asRoute } from "@/lib/typed-routes";
import { useOnboardingDecisions } from "@/lib/use-onboarding-decisions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const PLATFORM = "web" as const;

function emitOnboarding<E extends keyof OnboardingEventProps>(
  event: E,
  props: OnboardingEventProps[E],
): void {
  track(event, props as unknown as Record<string, unknown>);
}

/** Resolve the schema's abstract CTA route key to a concrete web path. */
const ROUTE_FOR_KEY: Record<OnboardingRouteKey, string> = {
  "settings.sending-identity": "/app/settings/sender",
  "settings.domain": "/app/settings/domain",
  "settings.team": "/app/settings/team",
  // No dedicated product-events route yet; the developer/integrations surface is
  // where event ingestion is configured.
  "settings.events": "/app/settings/integrations",
  subscribers: "/app/subscribers",
  "subscribers.import": "/app/subscribers/import",
  campaigns: "/app/campaigns",
  "campaigns.new": "/app/campaigns",
  // Sequences pair mirrors campaigns: a LIST key and a COMPOSE key.
  sequences: "/app/sequences",
  "sequences.new": "/app/sequences/new",
  forms: "/app/forms",
};

interface ResolvedGoal {
  goal: ChecklistGoal;
  label: string;
  description: string;
  completed: boolean;
  href: string;
}

/**
 * Merge the canonical, ordered `CHECKLIST_GOALS` with the server's per-step
 * state + copy. Server label/description win when present; otherwise the
 * schema fallbacks are used.
 */
function resolveGoals(progress: OnboardingProgress | null): ResolvedGoal[] {
  const byKey = new Map(
    (progress?.steps ?? []).map((s) => [s.key, s] as const),
  );
  return [...CHECKLIST_GOALS]
    .sort((a, b) => a.order - b.order)
    .map((goal) => {
      const server = byKey.get(goal.key);
      return {
        goal,
        label: server?.label?.trim() || goal.label,
        description: server?.description?.trim() || goal.description,
        completed: server?.completed ?? false,
        href: ROUTE_FOR_KEY[goal.ctaRouteKey] ?? "/app",
      };
    });
}

export function OnboardingChecklist({
  tenantId,
  userId,
  role,
  viewerMode,
}: {
  tenantId: string;
  userId: string;
  role: RoleKey;
  viewerMode: boolean;
}): JSX.Element {
  const prefersReducedMotion = useReducedMotion();
  const [celebrate, setCelebrate] = useState(false);
  const queryClient = useQueryClient();
  const decisionRuntime = useOnboardingDecisions({
    tenantId,
    userId,
    role,
    viewerMode,
  });
  const { authority } = decisionRuntime;
  const progressKey = useMemo(
    () => onboardingProgressKey(authority),
    [authority],
  );
  const previousProgressRef = useRef<{
    authorityKey: string;
    queryKey: readonly unknown[];
  } | null>(null);

  useEffect(() => {
    const previous = previousProgressRef.current;
    previousProgressRef.current = {
      authorityKey: authority.key,
      queryKey: progressKey,
    };
    if (!previous || previous.authorityKey === authority.key) return;
    setCelebrate(false);
    queryClient.removeQueries({ queryKey: previous.queryKey, exact: true });
  }, [authority.key, progressKey, queryClient]);

  const progressQuery = useQuery({
    queryKey: progressKey,
    queryFn: async ({ signal }): Promise<OnboardingProgress | null> => {
      const payload = await api.get<unknown>("/api/v1/onboarding-progress", {
        signal,
        requireOnline: true,
        maxAttempts: 1,
      });
      return isOnboardingProgress(payload) ? payload : null;
    },
    enabled: onboardingAuthorityReady(authority),
    staleTime: 60_000,
    retry: false,
  });

  const dismissed = surfaceIsDecidedAway(
    decisionRuntime.decisions,
    CHECKLIST_DECISION_STEP_KEY,
  );
  /**
   * Whether this person may RECORD a decision.
   *
   * `PUT /api/v1/onboarding/steps` is mounted under `write:campaigns`, which
   * the session path grants to owner/admin/editor and denies to viewer
   * (apps/api/internal/apikeys/middleware.go, `sessionRoleAllowsScopes`). A
   * viewer's dismissal would 403 and roll straight back, so the control is not
   * offered rather than offered and broken. READING a decision is unaffected —
   * the GET is a read scope, so a viewer still honours a dismissal recorded by
   * their own admin session on another device.
   *
   * If viewers should be able to put their own checklist away, that is a
   * server-side authorization change (route-contracts.json + a regenerated
   * routeauth manifest), not something this component may decide.
   */
  const canDecide = decisionRuntime.canDecide;
  const writeDecision = decisionRuntime.writeDecision;
  const dismiss = useCallback(() => {
    void writeDecision(CHECKLIST_DECISION_STEP_KEY, "dismissed").catch(
      () => undefined,
    );
  }, [writeDecision]);
  // No "undecided" exists in the vocabulary, and inventing one would give an
  // absent row a second meaning. `snoozed` is the honest undo, and it is what
  // mobile's "Show setup checklist" control writes, so the two agree.
  const restore = useCallback(() => {
    void writeDecision(CHECKLIST_DECISION_STEP_KEY, "snoozed").catch(
      () => undefined,
    );
  }, [writeDecision]);

  const progress = progressQuery.data ?? null;
  const resolved = useMemo(() => resolveGoals(progress), [progress]);

  const total = progress?.total ?? CHECKLIST_GOALS.length;
  const completed = progress?.completed ?? 0;
  const percent =
    progress?.percent ??
    (total > 0 ? Math.round((completed / total) * 100) : 0);
  const allDone = progress?.all_done ?? false;

  // Emit checklist_viewed ONCE per mount (after progress lands). Not while the
  // person has it dismissed: counting a view of a card nobody rendered would
  // make the funnel say the checklist is being seen when it is being avoided.
  const viewedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (viewedScopeRef.current === authority.key || !progress || dismissed) {
      return;
    }
    viewedScopeRef.current = authority.key;
    emitOnboarding(EVENTS.ONBOARDING_CHECKLIST_VIEWED, {
      platform: PLATFORM,
      completed: progress.completed,
      total: progress.total,
    });
  }, [authority.key, dismissed, progress]);

  // Persist the last observed completion state per tenant. A missing latch is
  // treated as the baseline (important for tenants that completed onboarding
  // before this UI shipped); only a real pending -> done transition celebrates.
  const observedCompletionRef = useRef<{
    key: string;
    state: "pending" | "done";
  } | null>(null);
  useEffect(() => {
    if (!progress || !onboardingAuthorityReady(authority)) return;
    const key = `postwave:onboarding-completion:${encodeURIComponent(authority.key)}`;
    const current = allDone ? "done" : "pending";
    let previous: string | null = null;
    try {
      previous = window.localStorage.getItem(key);
      window.localStorage.setItem(key, current);
    } catch {
      if (observedCompletionRef.current?.key === key) {
        previous = observedCompletionRef.current.state;
      }
    }
    observedCompletionRef.current = { key, state: current };
    setCelebrate(previous === "pending" && current === "done");
    if (previous === "pending" && current === "done") {
      emitOnboarding(EVENTS.ONBOARDING_CHECKLIST_COMPLETED, {
        platform: PLATFORM,
        total,
      });
    }
  }, [allDone, authority, progress, total]);

  const pathToSend = resolved.filter((r) => r.goal.tier === "path-to-send");
  const hardening = resolved.filter((r) => r.goal.tier === "hardening");

  if (decisionRuntime.isPending && !decisionRuntime.decisions) {
    return (
      <section
        data-tour="dashboard-onboarding"
        data-testid="onboarding-checklist-preferences-loading"
        className="rounded-lg border bg-card px-5 py-4"
        aria-label="Loading getting started preferences"
        aria-busy="true"
      >
        <p className="text-sm text-muted-foreground">
          Loading your setup checklist…
        </p>
      </section>
    );
  }

  const decisionDisabled =
    !decisionRuntime.isOnline || decisionRuntime.isWriting;
  const decisionDisabledReason = !decisionRuntime.isOnline
    ? "Reconnect to change this preference."
    : decisionRuntime.isWriting
      ? "Saving your onboarding preference…"
      : undefined;

  if (dismissed) {
    // Not silence. Vanishing entirely would make the decision irreversible
    // from the surface that took it, and would also delete the dashboard
    // tour's `dashboard-onboarding` anchor, so the tour would point at
    // nothing. A slim bar keeps both the anchor and the way back.
    return (
      <section
        data-tour="dashboard-onboarding"
        data-testid="onboarding-checklist-dismissed"
        className="flex items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/30 px-5 py-3"
        aria-label="Getting started checklist hidden"
      >
        <p className="text-sm text-muted-foreground">
          Setup checklist hidden
          {allDone ? "" : ` — ${completed} of ${total} done`}.
        </p>
        {canDecide ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-11 shrink-0 sm:h-8"
            onClick={restore}
            disabled={decisionDisabled}
            title={decisionDisabledReason}
            data-testid="onboarding-checklist-restore"
          >
            {decisionRuntime.isWriting ? "Saving…" : "Show checklist"}
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      // Keep this id so the dashboard tour's "onboarding" step still targets it.
      data-tour="dashboard-onboarding"
      data-testid="onboarding-checklist"
      // `relative` + `overflow-hidden` so the absolutely-positioned all-done
      // confetti layer anchors to (and is clipped by) this card, not the page.
      className="relative overflow-hidden rounded-lg border bg-card"
      aria-label="Getting started checklist"
    >
      <header className="flex items-center gap-4 border-b px-5 py-4">
        <ProgressRing
          percent={percent}
          allDone={allDone}
          reducedMotion={Boolean(prefersReducedMotion)}
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            {allDone ? "You're all set" : "Get sending"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {allDone
              ? "Every setup step is done — your account is ready to operate."
              : `${completed} of ${total} done — finish the path to your first send.`}
          </p>
        </div>
        {/* The decision, recorded for the person rather than the browser. Web
            had no dismiss control at all, so the only way to stop seeing this
            card was to finish every step. */}
        {canDecide ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-11 w-11 shrink-0 self-start text-muted-foreground sm:h-8 sm:w-8"
            onClick={dismiss}
            disabled={decisionDisabled}
            aria-label="Hide the getting started checklist"
            title={
              decisionDisabledReason ?? "Hide the getting started checklist"
            }
            data-testid="onboarding-checklist-dismiss"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </header>

      {!canDecide ? (
        <p
          className="border-b px-5 py-3 text-sm text-muted-foreground"
          data-testid="onboarding-checklist-read-only"
          role="status"
        >
          This checklist is read-only for your current role. An editor can
          complete sending tasks; an admin or owner can also finish workspace
          settings.
        </p>
      ) : null}

      {decisionRuntime.error ? (
        <p
          className="border-b px-5 py-3 text-sm text-destructive-emphasis"
          role="alert"
          data-testid="onboarding-checklist-decision-error"
        >
          {decisionRuntime.error.message}
        </p>
      ) : null}

      {decisionRuntime.isError ? (
        <p
          className="border-b px-5 py-3 text-sm text-muted-foreground"
          role="status"
        >
          Your saved checklist visibility could not be loaded. The checklist is
          shown so setup remains reachable.
        </p>
      ) : null}

      {progressQuery.isError ? (
        <p className="px-5 py-3 text-sm text-muted-foreground">
          Showing the default checklist — live progress couldn&apos;t be loaded.
        </p>
      ) : null}

      {/* Hero tier: the path-to-first-send spine. */}
      <ol className="divide-y" data-testid="onboarding-path-to-send">
        {pathToSend.map((r) => (
          <GoalRow
            key={r.goal.key}
            item={r}
            emphasized
            role={authority.role}
            viewerMode={authority.viewerMode}
          />
        ))}
      </ol>

      {/* Recessed tier: hardening goals. */}
      {hardening.length > 0 ? (
        <div className="border-t bg-muted/30">
          <p className="px-5 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Make it durable
          </p>
          <ol className="divide-y" data-testid="onboarding-hardening">
            {hardening.map((r) => (
              <GoalRow
                key={r.goal.key}
                item={r}
                emphasized={false}
                role={authority.role}
                viewerMode={authority.viewerMode}
              />
            ))}
          </ol>
        </div>
      ) : null}

      {celebrate && !prefersReducedMotion ? <ChecklistConfetti /> : null}
    </section>
  );
}

function GoalRow({
  item,
  emphasized,
  role,
  viewerMode,
}: {
  item: ResolvedGoal;
  emphasized: boolean;
  role: RoleKey;
  viewerMode: boolean;
}): JSX.Element {
  const { goal, label, description, completed, href } = item;
  const canOpenSetup = roleCanOpenGoal(role, viewerMode, goal.ctaRouteKey);
  return (
    <li
      data-testid="onboarding-goal"
      data-goal-key={goal.key}
      data-completed={completed ? "true" : "false"}
      className={cn(
        "flex items-start gap-3 px-5",
        emphasized ? "py-3.5" : "py-2.5",
        completed && "opacity-70",
      )}
    >
      <Checkmark completed={completed} emphasized={emphasized} />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "font-medium leading-snug",
            emphasized ? "text-sm" : "text-[13px]",
            completed && "text-muted-foreground line-through decoration-1",
          )}
        >
          {label}
        </p>
        {emphasized && !completed ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {!completed && canOpenSetup ? (
        <Button
          asChild
          size="sm"
          variant={emphasized ? "default" : "outline"}
          // ≥44px tap target on mobile (keeps sm padding/text; height only)
          // so the checklist's primary action clears the touch minimum
          // (OVR-028). Desktop stays compact at 32px.
          className="h-11 sm:h-8 shrink-0"
        >
          <Link href={asRoute(href)}>{emphasized ? "Start" : "Set up"}</Link>
        </Button>
      ) : !completed ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11 shrink-0 sm:h-8"
          disabled
          title="This setup task is read-only for your current role."
          data-testid={`onboarding-goal-read-only-${goal.key}`}
        >
          Read only
        </Button>
      ) : (
        <span className="shrink-0 self-center text-xs font-medium text-success">
          Done
        </span>
      )}
    </li>
  );
}

function roleCanOpenGoal(
  role: RoleKey,
  viewerMode: boolean,
  routeKey: OnboardingRouteKey,
): boolean {
  if (viewerMode || role === null || role === "viewer") return false;
  if (routeKey.startsWith("settings.")) {
    return role === "owner" || role === "admin";
  }
  return role === "owner" || role === "admin" || role === "editor";
}

function Checkmark({
  completed,
  emphasized,
}: {
  completed: boolean;
  emphasized: boolean;
}): JSX.Element {
  const size = emphasized ? "h-6 w-6" : "h-5 w-5";
  if (completed) {
    return (
      <anim.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{
          duration: tokens.durations.ringFillMs / 1000,
          ease: tokens.easing.spring.bezier as unknown as number[],
        }}
        className={cn(
          "mt-0.5 inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground",
          size,
        )}
        aria-hidden
      >
        <Check
          className={emphasized ? "h-3.5 w-3.5" : "h-3 w-3"}
          strokeWidth={3}
        />
      </anim.span>
    );
  }
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex shrink-0 rounded-full border-2 border-muted-foreground/30",
        size,
      )}
      aria-hidden
    />
  );
}

/**
 * Animated SVG progress ring. The arc fills over `motion.durations.ringFillMs`
 * with the standard easing; reduced-motion users get the final state with no
 * transition.
 */
function ProgressRing({
  percent,
  allDone,
  reducedMotion,
}: {
  percent: number;
  allDone: boolean;
  reducedMotion: boolean;
}): JSX.Element {
  const SIZE = 52;
  const STROKE = 5;
  const r = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div
      className="relative shrink-0"
      style={{ width: SIZE, height: SIZE }}
      role="img"
      aria-label={`${clamped}% of setup complete`}
      data-testid="onboarding-progress-ring"
    >
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-muted"
        />
        <anim.circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          className="stroke-primary"
          // Rotate so the arc starts at 12 o'clock.
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          strokeDasharray={circumference}
          initial={reducedMotion ? false : { strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : {
                  duration: tokens.durations.ringFillMs / 1000,
                  ease: tokens.easing.standard.bezier as unknown as number[],
                }
          }
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">
        {allDone ? (
          <Check className="h-4 w-4 text-primary" strokeWidth={3} aria-hidden />
        ) : (
          `${clamped}%`
        )}
      </span>
    </div>
  );
}

/**
 * Celebration confetti on all-done. Uses the shared `motion.confetti` palette
 * + counts so the burst matches the tour's completion feel. Gated by the
 * caller on reduced-motion.
 */
function ChecklistConfetti(): JSX.Element {
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const colors = isDark
    ? tokens.confetti.paletteDark
    : tokens.confetti.paletteLight;
  const pieces = Array.from({ length: tokens.confetti.count }, (_, i) => i);

  return (
    <div
      aria-hidden
      data-testid="onboarding-confetti"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {pieces.map((i) => {
        const angle =
          (i / pieces.length) * (tokens.confetti.spreadDeg * (Math.PI / 180));
        const distance = 120 + ((i * 37) % 120);
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance - 60;
        const color = colors[i % colors.length];
        return (
          <anim.span
            key={i}
            className="absolute left-1/2 top-6 h-2.5 w-1.5 rounded-[1px]"
            style={{ background: color }}
            initial={{ x: 0, y: 0, opacity: 0, rotate: 0, scale: 0.4 }}
            animate={{
              x,
              y,
              opacity: [0, 1, 0],
              rotate: (i % 2 ? 1 : -1) * 320,
              scale: 1,
            }}
            transition={{
              duration: tokens.confetti.flightMs / 1000,
              delay: (i * tokens.confetti.staggerMs) / 1000,
              ease: tokens.easing.decelerate.bezier as unknown as number[],
            }}
          />
        );
      })}
    </div>
  );
}
