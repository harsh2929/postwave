import {
  PERSISTENT_DESKTOP_SECTIONS,
  type PersistentDesktopSection,
} from "./desktop-routes";
import type { DesktopRoute } from "./desktop-router";
import type { Role } from "./store";

export const ONBOARDING_SURFACE_IDS = [
  "wizard",
  "checklist",
  "tour",
  "catalog",
] as const;

export type OnboardingSurfaceId = (typeof ONBOARDING_SURFACE_IDS)[number];
export type OnboardingPresentation =
  | "modal-wizard"
  | "inline-checklist"
  | "spotlight-tour"
  | "modal-catalog";
export type OnboardingAutoOpenPolicy =
  | "fresh-workspace"
  | "after-wizard"
  | "inline"
  | "manual-only";

export type WizardStepId = "domain" | "subscribers" | "campaign" | "done";
export type ChecklistStepId =
  | "verify-domain"
  | "import-subscribers"
  | "send-first-campaign"
  | "connect-events"
  | "harden-deliverability";
export type TourStepId =
  | "welcome"
  | "sidebar"
  | "stat-cards"
  | "recent-campaigns"
  | "campaigns-page"
  | "new-campaign"
  | "subscribers-page"
  | "sequences-page"
  | "settings-page"
  | "done"
  | `workspace-${PersistentDesktopSection | "welcome" | "done"}`;
export type CatalogStepId =
  | "lists"
  | "campaigns"
  | "domains"
  | "ai"
  | "approvals";
export type OnboardingStepId =
  | WizardStepId
  | ChecklistStepId
  | TourStepId
  | CatalogStepId;

const ALL_ROLES: readonly Role[] = ["admin", "editor", "viewer"];
const MUTATING_ROLES: readonly Role[] = ["admin", "editor"];

export interface OnboardingStepManifest<Id extends OnboardingStepId> {
  id: Id;
  label: string;
  roles: readonly Role[];
  route?: DesktopRoute;
}

export interface WizardStepManifest
  extends OnboardingStepManifest<WizardStepId> {
  hint: string;
}

export interface ChecklistStepManifest
  extends OnboardingStepManifest<ChecklistStepId> {
  description: string;
  unlockedBadge: string;
  goLabel: string;
  goalKey:
    | "verified_sending_identity"
    | "created_subscriber"
    | "sent_first_campaign"
    | "connected_product_events"
    | "configured_dkim_dmarc";
  tier: "path-to-send" | "hardening";
}

export interface TourStepManifest
  extends OnboardingStepManifest<TourStepId> {
  targetSelector: string | null;
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  title: string;
  body: string;
  hideBack?: boolean;
  isFinal?: boolean;
  skipIfGoalDone?: ChecklistStepManifest["goalKey"];
}

export interface CatalogStepManifest
  extends OnboardingStepManifest<CatalogStepId> {
  icon: string;
  title: string;
  body: string;
  shortcutIds: readonly string[];
}

export const WIZARD_STEPS: readonly WizardStepManifest[] = [
  {
    id: "domain",
    label: "Verify your domain",
    hint: "SPF · DKIM · DMARC",
    roles: MUTATING_ROLES,
    route: { section: "domains" },
  },
  {
    id: "subscribers",
    label: "Add your people",
    hint: "Import a CSV or add one person",
    roles: MUTATING_ROLES,
    route: { section: "subscribers" },
  },
  {
    id: "campaign",
    label: "Create a campaign",
    hint: "Draft your first broadcast",
    roles: MUTATING_ROLES,
    route: { section: "campaigns" },
  },
  {
    id: "done",
    label: "You're ready to send",
    hint: "Land in the inbox",
    roles: MUTATING_ROLES,
  },
] as const;

export const CHECKLIST_STEPS: readonly ChecklistStepManifest[] = [
  {
    id: "verify-domain",
    label: "Verify your sending domain",
    description:
      "Generate DKIM, SPF, and return-path records. Moosewave verifies them continuously before your first production send.",
    unlockedBadge: "DKIM verified",
    goLabel: "Open Custom Domains",
    goalKey: "verified_sending_identity",
    tier: "path-to-send",
    roles: MUTATING_ROLES,
    route: { section: "domains" },
  },
  {
    id: "import-subscribers",
    label: "Import your first subscribers",
    description:
      "Upload a CSV, paste a list, or add one person. Moosewave de-duplicates and checks the global suppression list.",
    unlockedBadge: "Audience ready",
    goLabel: "Add subscribers",
    goalKey: "created_subscriber",
    tier: "path-to-send",
    roles: MUTATING_ROLES,
    route: { section: "subscribers", overlay: { name: "import" } },
  },
  {
    id: "send-first-campaign",
    label: "Send your first campaign",
    description:
      "Pick a template, write the copy, choose an audience, and complete a test send before scheduling.",
    unlockedBadge: "First send complete",
    goLabel: "Open Campaigns",
    goalKey: "sent_first_campaign",
    tier: "path-to-send",
    roles: MUTATING_ROLES,
    route: { section: "campaigns" },
  },
  {
    id: "connect-events",
    label: "Connect your site or app",
    description:
      "Send product events to Track, embed a form, or connect an inbound webhook to trigger sequences.",
    unlockedBadge: "Real-time events flowing",
    goLabel: "Open Track",
    goalKey: "connected_product_events",
    tier: "hardening",
    roles: MUTATING_ROLES,
    route: { section: "track" },
  },
  {
    id: "harden-deliverability",
    label: "Harden deliverability",
    description:
      "Publish DMARC, review suppressions, and confirm the controls that protect inbox placement.",
    unlockedBadge: "Deliverability hardened",
    goLabel: "Open DMARC",
    goalKey: "configured_dkim_dmarc",
    tier: "hardening",
    roles: MUTATING_ROLES,
    route: { section: "dmarc" },
  },
] as const;

export const TOUR_STEPS: readonly TourStepManifest[] = [
  {
    id: "welcome",
    label: "Welcome",
    title: "Welcome to Moosewave",
    body: "A short, optional tour will orient you without changing workspace data.",
    targetSelector: null,
    hideBack: true,
    roles: ALL_ROLES,
    route: { section: "dashboard" },
  },
  {
    id: "sidebar",
    label: "Navigation",
    title: "Everything lives in this rail",
    body: "Audience, campaigns, automations, analytics, and settings stay one command or click away.",
    targetSelector: "sidebar",
    placement: "right",
    roles: ALL_ROLES,
    route: { section: "dashboard" },
  },
  {
    id: "stat-cards",
    label: "Workspace health",
    title: "Read workspace health at a glance",
    body: "These cards summarize audience growth, campaign activity, and delivery health.",
    targetSelector: "dashboard-stats",
    placement: "bottom",
    roles: ALL_ROLES,
    route: { section: "dashboard" },
  },
  {
    id: "recent-campaigns",
    label: "Recent campaigns",
    title: "Open a campaign to inspect it",
    body: "Recent work links to delivery, engagement, and recipient-level detail through the canonical campaign route.",
    targetSelector: "dashboard-recent-campaigns",
    placement: "right",
    roles: ALL_ROLES,
    route: { section: "dashboard" },
  },
  {
    id: "campaigns-page",
    label: "Campaign workspace",
    title: "Your campaigns workspace",
    body: "Drafts, schedules, tests, approvals, and sent work share one routed workspace.",
    targetSelector: "campaigns-list",
    placement: "top",
    roles: ALL_ROLES,
    route: { section: "campaigns" },
  },
  {
    id: "new-campaign",
    label: "Campaigns",
    title: "Create and review campaigns",
    body: "Draft, test, approve, and schedule broadcasts from the Campaigns workspace.",
    targetSelector: "campaigns-new-button",
    placement: "bottom",
    skipIfGoalDone: "sent_first_campaign",
    roles: ALL_ROLES,
    route: { section: "campaigns" },
  },
  {
    id: "subscribers-page",
    label: "Subscribers",
    title: "Understand your audience",
    body: "Search, segment, import, and inspect subscribers without losing your current route.",
    targetSelector: "subscribers-list",
    placement: "top",
    skipIfGoalDone: "created_subscriber",
    roles: ALL_ROLES,
    route: { section: "subscribers" },
  },
  {
    id: "sequences-page",
    label: "Sequences",
    title: "Build lifecycle journeys",
    body: "Sequences combine ordered messages, timing, and branches into reusable journeys.",
    targetSelector: "sequences-list",
    placement: "top",
    roles: ALL_ROLES,
    route: { section: "sequences" },
  },
  {
    id: "settings-page",
    label: "Sending identity",
    title: "Finish your sending identity",
    body: "Domain authentication and delivery controls are available from the dedicated Domains workspace.",
    targetSelector: null,
    skipIfGoalDone: "verified_sending_identity",
    roles: ALL_ROLES,
    route: { section: "domains" },
  },
  {
    id: "done",
    label: "Tour complete",
    title: "You're oriented",
    body: "You can resume or reset onboarding from Help whenever your role or task changes.",
    targetSelector: null,
    isFinal: true,
    roles: ALL_ROLES,
    route: { section: "dashboard" },
  },
] as const;

/**
 * The full workspace walkthrough is loaded lazily so its substantial,
 * human-written copy does not inflate the initial shell bundle. Its step IDs
 * still have to be recognized by the durable onboarding state machine before
 * that chunk can open or advance the tour. Keep the compact ID registry here,
 * beside the canonical quick-tour manifest used by the validator.
 */
const FULL_WORKSPACE_TOUR_STEP_IDS: ReadonlySet<string> = new Set([
  "workspace-welcome",
  ...PERSISTENT_DESKTOP_SECTIONS.map((section) => `workspace-${section}`),
  "workspace-done",
]);

export const CATALOG_STEPS: readonly CatalogStepManifest[] = [
  {
    id: "lists",
    label: "Audience",
    icon: "L",
    title: "Audience: Lists, Tags, Suppressions",
    body: "Group subscribers, tag them inline, and maintain the global suppression file.",
    roles: ALL_ROLES,
    route: { section: "lists" },
    shortcutIds: ["nav.lists"],
  },
  {
    id: "campaigns",
    label: "Compose",
    icon: "C",
    title: "Compose: Campaigns, Sequences, Templates, Assets",
    body: "Draft broadcasts, build journeys, and reuse approved creative.",
    roles: ALL_ROLES,
    route: { section: "campaigns" },
    shortcutIds: ["nav.campaigns"],
  },
  {
    id: "domains",
    label: "Deliverability",
    icon: "D",
    title: "Send-time optimization, DMARC, Custom domains",
    body: "Verify sender DNS, monitor DMARC, and configure tracking domains.",
    roles: ALL_ROLES,
    route: { section: "domains" },
    shortcutIds: ["nav.domains"],
  },
  {
    id: "ai",
    label: "Moosewave AI",
    icon: "A",
    title: "Moosewave AI",
    body: "Use voice, placement, and content diagnostics with workspace policy controls.",
    roles: ALL_ROLES,
    route: { section: "ai" },
    shortcutIds: ["nav.ai"],
  },
  {
    id: "approvals",
    label: "Governance",
    icon: "P",
    title: "Approvals and Audit log",
    body: "Review agent-drafted work and inspect the workspace's change history.",
    roles: ALL_ROLES,
    route: { section: "approvals" },
    shortcutIds: ["nav.approvals", "nav.audit"],
  },
] as const;

export interface OnboardingSurfaceManifest {
  id: OnboardingSurfaceId;
  label: string;
  presentation: OnboardingPresentation;
  autoOpen: OnboardingAutoOpenPolicy;
  roles: readonly Role[];
  steps: readonly OnboardingStepManifest<OnboardingStepId>[];
}

export const ONBOARDING_SURFACES: Readonly<
  Record<OnboardingSurfaceId, OnboardingSurfaceManifest>
> = {
  wizard: {
    id: "wizard",
    label: "First-run setup wizard",
    presentation: "modal-wizard",
    autoOpen: "fresh-workspace",
    roles: MUTATING_ROLES,
    steps: WIZARD_STEPS,
  },
  checklist: {
    id: "checklist",
    label: "Dashboard setup checklist",
    presentation: "inline-checklist",
    autoOpen: "inline",
    roles: MUTATING_ROLES,
    steps: CHECKLIST_STEPS,
  },
  tour: {
    id: "tour",
    label: "Product spotlight tour",
    presentation: "spotlight-tour",
    autoOpen: "after-wizard",
    roles: ALL_ROLES,
    steps: TOUR_STEPS,
  },
  catalog: {
    id: "catalog",
    label: "Settings quick-tour catalog",
    presentation: "modal-catalog",
    autoOpen: "manual-only",
    roles: ALL_ROLES,
    steps: CATALOG_STEPS,
  },
};

export function isOnboardingSurfaceApplicable(
  surface: OnboardingSurfaceId,
  role: Role | null | undefined,
): boolean {
  return role != null && ONBOARDING_SURFACES[surface].roles.includes(role);
}

export function onboardingStepsForRole(
  surface: OnboardingSurfaceId,
  role: Role | null | undefined,
): readonly OnboardingStepManifest<OnboardingStepId>[] {
  if (!isOnboardingSurfaceApplicable(surface, role)) return [];
  return ONBOARDING_SURFACES[surface].steps.filter(
    (step) => role != null && step.roles.includes(role),
  );
}

export function isKnownOnboardingStep(
  surface: OnboardingSurfaceId,
  stepId: string,
): stepId is OnboardingStepId {
  return (
    ONBOARDING_SURFACES[surface].steps.some((step) => step.id === stepId) ||
    (surface === "tour" && FULL_WORKSPACE_TOUR_STEP_IDS.has(stepId))
  );
}
