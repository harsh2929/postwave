/**
 * Canonical PostHog event-name taxonomy. The audit found two parallel
 * naming conventions server-side and a double-emitted `tenant_created`.
 * Importing names from here (instead of inline string literals) prevents
 * divergence and double-emit across web/desktop/mobile/api.
 *
 * Convention: lowercase, dot-namespaced `domain.action`, past-tense action.
 */
export const EVENTS = {
  // lifecycle
  TENANT_CREATED: "tenant.created",
  USER_SIGNED_IN: "user.signed_in",
  USER_SIGNED_OUT: "user.signed_out",
  // mobile release health (structural fields only; no customer content)
  MOBILE_APP_OPENED: "mobile.app_opened",
  MOBILE_TAB_VIEWED: "mobile.tab_viewed",
  MOBILE_AUTH_COMPLETED: "mobile.auth_completed",
  MOBILE_MFA_COMPLETED: "mobile.mfa_completed",
  MOBILE_LINK_HANDLED: "mobile.link_handled",
  MOBILE_PUSH_REGISTRATION_COMPLETED: "mobile.push_registration_completed",
  MOBILE_PUSH_REVOCATION_COMPLETED: "mobile.push_revocation_completed",
  MOBILE_OFFLINE_REPLAY_COMPLETED: "mobile.offline_replay_completed",
  MOBILE_API_AVAILABILITY: "mobile.api_availability",
  // Mobile shell interaction. The search palette, the notification inbox and
  // settings toggles emitted NOTHING, so nobody could tell whether the palette
  // was used, which queries returned zero, or which settings people change.
  // Structural fields only: a query's LENGTH and result count, never its text.
  MOBILE_SEARCH_PERFORMED: "mobile.search_performed",
  MOBILE_NOTIFICATION_OPENED: "mobile.notification_opened",
  MOBILE_SETTING_CHANGED: "mobile.setting_changed",
  // Mobile DASHBOARD interaction. The app's most-visited screen emitted
  // nothing, so there was no evidence for which reporting window people
  // actually read, which headline number they drill into, or how often the
  // screen fails in the field.
  //
  // There is deliberately NO `mobile.dashboard_viewed`: the tab layout
  // already emits `mobile.tab_viewed` with `tab: "dashboard"`, and a second
  // view event for the same fact is exactly the double-emit this file exists
  // to prevent. The range is carried on the interactions instead.
  //
  // Structural fields only: a window enum, a metric KEY, a failure KIND from
  // the client's own taxonomy, and a status code. Never a workspace figure —
  // the counts themselves are customer data and stay on the device.
  MOBILE_DASHBOARD_RANGE_CHANGED: "mobile.dashboard_range_changed",
  MOBILE_DASHBOARD_REFRESHED: "mobile.dashboard_refreshed",
  MOBILE_METRIC_DRILLDOWN: "mobile.metric_drilldown",
  MOBILE_DASHBOARD_ERROR: "mobile.dashboard_error",
  // Mobile OS-INTEGRATION health. The native cluster — home-screen widget,
  // notification + camera permissions — had no signal at all, so nobody could
  // tell whether a widget that shows nothing is opted out, starved of data, or
  // failing its App Group write, nor how often a permission prompt is refused.
  //
  // Both are OUTCOME events, not content: `kind` names the surface
  // (widget / notifications / camera), `outcome` is a bounded enum from the
  // client's own taxonomy. No workspace figure ever rides along — the widget's
  // numbers are customer data and stay in the App Group.
  MOBILE_WIDGET_STATE: "mobile.widget_state",
  MOBILE_PERMISSION_OUTCOME: "mobile.permission_outcome",
  // Mobile COMMERCE/CONNECTOR cluster actions. Billing, integrations, inbound
  // and outbound webhooks, discounts and the QR scanner shipped as fully
  // interactive screens that emitted nothing but a tab view, so every question
  // about them ("does anyone replay a delivery from the phone?") was
  // unanswerable. `kind` is the screen's own bounded action slug and `outcome`
  // is success/failure/refused — never an endpoint id, secret, or object name.
  MOBILE_COMMERCE_ACTION: "mobile.commerce_action",
  // campaigns
  CAMPAIGN_CREATED: "campaign.created",
  CAMPAIGN_SENT: "campaign.sent",
  CAMPAIGN_SCHEDULED: "campaign.scheduled",
  // subscribers
  SUBSCRIBER_CREATED: "subscriber.created",
  SUBSCRIBER_IMPORTED: "subscriber.imported",
  // Audience INTERACTION. The whole audience cluster emitted nothing on any
  // client, so there was no way to know whether anyone searches, filters,
  // opens a profile, tags, or suppresses — and therefore no data behind any
  // decision about it. Structural fields only: a query's LENGTH and result
  // count, a filter KEY, an outcome enum. Never an address, a name, a tag
  // string, or a subscriber id.
  SUBSCRIBER_SEARCHED: "subscriber.searched",
  SUBSCRIBER_FILTER_APPLIED: "subscriber.filter_applied",
  SUBSCRIBER_PROFILE_VIEWED: "subscriber.profile_viewed",
  SUBSCRIBER_TAGGED: "subscriber.tagged",
  SUBSCRIBER_STATUS_CHANGED: "subscriber.status_changed",
  SUBSCRIBER_SUPPRESSED: "subscriber.suppressed",
  // automations
  SEQUENCE_ACTIVATED: "sequence.activated",
  // governance
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_DECIDED: "approval.decided",
  // onboarding / walkthrough — emitted by every client's tour, checklist,
  // and wizard so onboarding engagement is measurable cross-platform.
  // Properties are documented in @postwave/onboarding-schema (analytics.ts).
  ONBOARDING_TOUR_STARTED: "onboarding.tour_started",
  ONBOARDING_TOUR_STEP_VIEWED: "onboarding.tour_step_viewed",
  ONBOARDING_TOUR_STEP_SKIPPED: "onboarding.tour_step_skipped",
  ONBOARDING_TOUR_COMPLETED: "onboarding.tour_completed",
  ONBOARDING_TOUR_DISMISSED: "onboarding.tour_dismissed",
  ONBOARDING_CHECKLIST_VIEWED: "onboarding.checklist_viewed",
  ONBOARDING_CHECKLIST_GOAL_COMPLETED: "onboarding.checklist_goal_completed",
  ONBOARDING_CHECKLIST_COMPLETED: "onboarding.checklist_completed",
  ONBOARDING_WIZARD_STARTED: "onboarding.wizard_started",
  ONBOARDING_WIZARD_STEP_COMPLETED: "onboarding.wizard_step_completed",
  ONBOARDING_WIZARD_COMPLETED: "onboarding.wizard_completed",
  ONBOARDING_MILESTONE_CELEBRATED: "onboarding.milestone_celebrated",
  ONBOARDING_EMPTY_STATE_CTA_CLICKED: "onboarding.empty_state_cta_clicked",
  ONBOARDING_NUDGE_SHOWN: "onboarding.nudge_shown",
  ONBOARDING_NUDGE_ACCEPTED: "onboarding.nudge_accepted",

  // Operations console (internal control plane). Registered here so operator
  // actions have canonical, drift-guarded names the moment ops joins the
  // observability plane — the de-islanding Phase-0 step. NOTE: the console's
  // telemetry EMITTER stays an operator opt-in (it egresses control-plane
  // actions to an external sink); these are names only, no egress.
  OPS_KILL_SWITCH_TOGGLED: "ops.kill_switch_toggled",
  OPS_INCIDENT_DECLARED: "ops.incident_declared",
  OPS_INCIDENT_UPDATED: "ops.incident_updated",
  OPS_CHECK_SNOOZED: "ops.check_snoozed",
  OPS_CHECK_ACTIONED: "ops.check_actioned",

  // Cross-device continuity (the resume cursor). Read failures need a name
  // because on screen they are INVISIBLE: a broken endpoint and "this user has
  // no cursor yet" both render as no card at all. Without this event the
  // feature can be dead in production and look exactly like a quiet one.
  CONTINUITY_RESUME_READ_FAILED: "continuity.resume_read_failed",
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

/** Guard for runtime payloads: is this a recognized canonical event? */
export function isKnownEvent(name: string): name is EventName {
  return (Object.values(EVENTS) as string[]).includes(name);
}
