#!/usr/bin/env node
//
// scripts/check-entitlement-denials.mjs
//
// "You cannot do this" must be one shape, and it must say WHY in a form a
// client can act on.
//
// The blueprint asks for a shared entitlement/policy explanation so every new
// feature stops inventing its own plan/role/flag behaviour. Measured before
// this gate existed: 77 sites returning 402/403, and 65 distinct `reason` field
// shapes. Two of them were byte-for-byte hand copies of the SAME rule —
// `limits` and `campaigns` each built the identical `plan_limit_exceeded`
// envelope, so a change to one diverged from the other with nothing to notice.
//
// The cost is not tidiness. A client cannot act on prose: "upgrade your plan",
// "ask an admin", "wait for the window to reset" and "this is switched off for
// your workspace" need four different affordances, and without a machine-
// readable class a surface has to pattern-match an error string to tell them
// apart. That is how a paywall gets shown to someone whose workspace already
// paid, and how a 60-second rate limit gets presented as a dead end.
//
// Every source-level 402/403/429 emitter is now fail-closed: it must either use
// internal/entitlement (whose Reason is the classification) or appear in the
// explicit boundary exemption register below. Exemptions are limited to
// security, authentication, and HTTP/provider protocol semantics where
// replacing the response with a product-entitlement envelope would disclose
// policy or lie about the remedy.
//
// Usage:
//   node scripts/check-entitlement-denials.mjs
//   node scripts/check-entitlement-denials.mjs --self-test

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const CONTRACT = "apps/api/internal/entitlement/denial.go";

/** Sites converted to the shared contract. Regressing one is a build failure. */
const CONVERTED = [
  {
    id: "limits-plan-ceiling",
    file: "apps/api/internal/limits/limits.go",
    fn: "WriteExceeded",
    why: "The original of the duplicated plan-limit envelope.",
  },
  {
    id: "rbac-permission-chokepoint",
    file: "apps/api/internal/rbac/rbac.go",
    fn: "RequirePermission",
    why:
      "THE permission chokepoint — every session-cookie route gated on a " +
      "permission refuses here. It emitted a hand-concatenated envelope with no " +
      "machine-readable class, so a client could not tell a role refusal from a " +
      "plan one: the exact confusion that shows a paywall to someone who needs " +
      "an admin to change their role.",
  },
  {
    id: "emailpreview-render-quota",
    file: "apps/api/internal/emailpreview/handlers.go",
    fn: "Render",
    why:
      "Returned a bare `quota_exceeded` string. A metered plan allowance whose " +
      "denial names no resource and no ceiling cannot be rendered by any client.",
  },
  {
    id: "inboxreality-test-quota",
    file: "apps/api/internal/inboxreality/handlers.go",
    fn: "CreateTest",
    why: "The same bare `quota_exceeded` envelope, hand-copied into a second package.",
  },
  {
    id: "verification-provider-credits",
    file: "apps/api/internal/verification/handlers.go",
    fn: "writeNoCreditsDenial",
    why:
      "Provider credit exhaustion. Registered because its REMEDY is the point: " +
      "no Moosewave plan change resolves it, so a denial that offered " +
      "`upgrade_plan` would send someone to a billing page that cannot fix it.",
  },
  {
    id: "campaigns-queue-quota",
    file: "apps/api/internal/campaigns/quota.go",
    fn: "quotaExceededQueueError",
    why: "The hand copy of it. Both now build from entitlement.PlanLimit.",
  },
  {
    id: "security-sso-runtime",
    file: "apps/api/internal/handlers/security.go",
    fn: "Update",
    why:
      "Converted but never registered, so the property had no guard. The one " +
      "ReasonRuntime site in the tree: SSO configuration is accepted nowhere " +
      "because no ACS route exists, and a denial that offered `upgrade_plan` " +
      "would send an operator to a billing page that cannot make it work.",
  },
  {
    id: "subject-lab-feature-flag",
    file: "apps/api/internal/subject_lab/subject_lab.go",
    fn: "generate",
    why:
      "A ReasonFlag denial that read as `403 feature_disabled` prose, " +
      "indistinguishable from a plan refusal. The affordances are opposite: an " +
      "upgrade button sends someone to a billing page that cannot turn a flag on.",
  },
  {
    id: "agency-not-agency",
    file: "apps/api/internal/agency/denials.go",
    fn: "writeNotAgencyDenial",
    why:
      "The same 403 envelope hand-copied into THREE handlers. ReasonFlag with " +
      "no remedy: `is_agency_account` is workspace configuration, so neither an " +
      "upgrade nor an admin can turn it on, and offering either would send " +
      "someone somewhere that cannot help.",
  },
  {
    id: "approvals-self-approval",
    file: "apps/api/internal/approvals/denials.go",
    fn: "writeSelfApprovalDenial",
    why:
      "Separation of duties is the point of an approval: no role grants it and " +
      "no plan buys it. Hand-copied into two handlers, both as prose, so a " +
      "client could not tell it from 'you need the admin role' — which wants " +
      "the opposite screen.",
  },
  {
    id: "approvals-role",
    file: "apps/api/internal/approvals/denials.go",
    fn: "writeApprovalsRoleDenial",
    why:
      "The one refusal on that surface that IS a person to go and ask, so it " +
      "carries RequiredRole — apps/web renders the role name, and without it " +
      "the best available copy is 'ask an administrator', wrong whenever the " +
      "required role is something else.",
  },
  {
    id: "auth-viewer-mode-role",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeViewerModeRoleDenial",
    why:
      "A genuine role refusal, carrying RequiredRole so the client can name it " +
      "rather than fall back to 'ask an administrator'.",
  },
  {
    id: "auth-viewer-mode-not-downgrade",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeViewerModeNotDowngradeDenial",
    why:
      "Sits beside the role denial above and is NOT one: an owner previewing " +
      "as an owner is asking for something the feature does not mean, and no " +
      "permission change makes it valid. The pair is why prose was not enough.",
  },
  {
    id: "auth-email-not-verified",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeEmailNotVerifiedDenial",
    why:
      "The one refusal on this surface the caller resolves themselves. " +
      "Classifying it as a role problem would send them to an admin who cannot " +
      "verify their email for them.",
  },
  {
    id: "auth-workspace-access-revoked",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeWorkspaceAccessRevokedDenial",
    why:
      "Sent an EMPTY message before conversion, which renders as a blank " +
      "refusal — a dialog with nothing in it. Registered partly so that cannot " +
      "come back.",
  },
  {
    id: "rbac-insufficient-permission",
    file: "apps/api/internal/rbacresolve/denials.go",
    fn: "writeInsufficientPermissionDenial",
    why:
      "The permission-resolution path's role refusal. Registered as a PAIR with " +
      "the one below, which sat beside it and meant the opposite.",
  },
  {
    id: "rbac-permission-check-failed",
    file: "apps/api/internal/rbacresolve/denials.go",
    fn: "writePermissionCheckFailedDenial",
    why:
      "The fail-closed path when the grant store cannot be READ. It shipped as " +
      "the same 403-with-prose as a real role refusal, so a client told the " +
      "user their permissions were lacking when the system could not look. Now " +
      "ReasonRuntime, which also moved it 403 -> 503: a 403 asserts 'you are " +
      "not allowed', and that is not something we know here.",
  },
  {
    id: "workspace-owner-role-required",
    file: "apps/api/internal/handlers/workspace_members_denials.go",
    fn: "writeOwnerRoleRequiredDenial",
    why:
      "Hand-written at two sites. Carries RequiredRole: 'owner', because the " +
      "generic fallback is 'ask an administrator' and an admin cannot grant the " +
      "owner role either.",
  },
  {
    id: "auth-mfa-challenge",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeMFAChallengeDenial",
    why:
      "Written at two sites with different wording. Registered as a PAIR with " +
      "the policy denial below, which reads almost identically and means " +
      "something else.",
  },
  {
    id: "auth-mfa-policy",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeMFAPolicyDenial",
    why:
      "'Complete a challenge' vs 'your workspace requires an enrolled factor' " +
      "— the second has no challenge to complete, so a client that treats them " +
      "alike offers a button that does nothing. The distinct code is the whole " +
      "point of registering it.",
  },
  {
    id: "auth-oauth-unverified-email",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeProviderUnverifiedEmailDenial",
    why:
      "A fact about what the identity provider asserted. No role, plan or admin " +
      "in Moosewave changes it, so the remedy is deliberately empty — anything " +
      "else points at a dead end.",
  },
  {
    id: "auth-oauth-email-mismatch",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeProviderEmailMismatchDenial",
    why: "The same class: the provider's verified email is not ours to change.",
  },
  {
    id: "sending-direct-provision-disabled",
    file: "apps/api/internal/handlers/workspace_members_denials.go",
    fn: "writeDirectProvisionDisabledDenial",
    why:
      "An operator switch, not a plan or a role — bypassing billing must be a " +
      "deliberate decision. Registered partly to keep the env-var override in " +
      "the message: its reader is the ops engineer who needs it.",
  },
  {
    id: "impersonation-read-only",
    file: "apps/api/internal/impersonate/denials.go",
    fn: "writeImpersonationReadOnlyDenial",
    why:
      "The support engineer's own role may be unlimited; what limits them is " +
      "the SESSION they chose. ReasonRole would invite 'ask for more access' " +
      "when the answer is 'switch scope or restart'.",
  },
  {
    id: "cli-mfa-required",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeCLIMFARequiredDenial",
    why:
      "Registered as a PAIR with the role denial below: a terminal user given " +
      "prose cannot tell 'do this now' from 'find a colleague'.",
  },
  {
    id: "cli-insufficient-role",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeCLIInsufficientRoleDenial",
    why:
      "Carries RequiredRole so a terminal user does not have to guess which " +
      "colleague to ask. `cliErr` produced the same envelope shape, so the " +
      "added keys are a strict superset and no CLI consumer breaks.",
  },
  {
    id: "pii-stable-reviewer-required",
    file: "apps/api/internal/pii_scanner/denials.go",
    fn: "writeStableReviewerRequiredDenial",
    why:
      "A PII review has to be attributable to a person — an API key is not one, " +
      "so the decision would land with nobody's name on it. ReasonPolicy, not " +
      "Role: no role turns an anonymous credential into a person.",
  },
  {
    id: "apikeys-insufficient-role",
    file: "apps/api/internal/apikeys/denials.go",
    fn: "writeInsufficientRoleDenial",
    why:
      "THE route gate. Registered as a PAIR with the scope denial below — eight " +
      "hand-written sites across one file, two causes, one affordance.",
  },
  {
    id: "apikeys-insufficient-scope",
    file: "apps/api/internal/apikeys/denials.go",
    fn: "writeInsufficientScopeDenial",
    why:
      "A scoped API key is a narrowing its OWNER chose; no role change widens " +
      "it. Classified as Role, this produced the one piece of advice guaranteed " +
      "not to work — sending an integrator to their workspace admin instead of " +
      "to their own key settings.",
  },
  {
    id: "routeauth-unclassified",
    file: "apps/api/internal/routeauth/denials.go",
    fn: "writeUnclassifiedRouteDenial",
    why:
      "Fires when the MANIFEST has no approved policy for a route. Nothing " +
      "about the caller is wrong — it is a deployment gap — so reporting it as " +
      "a permission problem sends someone hunting a permission that was never " +
      "the issue. Still a refusal: an unclassified route must never default to " +
      "allowed.",
  },
  {
    id: "routeauth-auth-method",
    file: "apps/api/internal/routeauth/denials.go",
    fn: "writeAuthMethodDenial",
    why:
      "An API key on a session-only route. No scope and no role fix it — the " +
      "caller must authenticate differently, which is why it cannot collapse " +
      "into either.",
  },
  {
    id: "routeauth-role",
    file: "apps/api/internal/routeauth/denials.go",
    fn: "writeRouteRoleDenial",
    why: "The manifest gate's role refusal; pairs with the scope one below.",
  },
  {
    id: "routeauth-scope",
    file: "apps/api/internal/routeauth/denials.go",
    fn: "writeRouteScopeDenial",
    why:
      "Message parameterised because the two sites say 'does not have " +
      "permission' vs 'does not have EVERY permission' — for an integrator " +
      "debugging a conjunctive scope requirement that distinction IS the error.",
  },
  {
    id: "rbac-builtin-role",
    file: "apps/api/internal/handlers/workspace_members_denials.go",
    fn: "writeBuiltInRoleDenial",
    why:
      "A fact about the RESOURCE, not the caller: no permission makes a " +
      "built-in role deletable, so Role would produce advice that cannot work " +
      "for anyone.",
  },
  {
    id: "audit-pii-scope",
    file: "apps/api/internal/handlers/workspace_members_denials.go",
    fn: "writeAuditPIIScopeDenial",
    why:
      "The audit-PII gate, same class as the API-key scope refusals. The scope " +
      "NAME stays in the message because it is the whole answer.",
  },
  {
    id: "mfa-policy-gate",
    file: "apps/api/internal/middleware/mfa_gate.go",
    fn: "writeMFAPolicyGateDenial",
    why:
      "The tenant two-factor gate. Registered partly because converting it " +
      "exposed the writer beside it building JSON by string concatenation — " +
      "safe only while every message stayed quote-free.",
  },
  {
    id: "apikeys-auth-method",
    file: "apps/api/internal/apikeys/denials.go",
    fn: "writeAuthMethodDenial",
    why:
      "Neither a role nor a scope fixes a credential TYPE the route rejects — " +
      "the caller has to authenticate differently.",
  },
  {
    id: "auth-device-approval-mfa",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeDeviceApprovalMFADenial",
    why:
      "Approving a DEVICE grants a new machine standing access — the " +
      "higher-stakes of the two MFA gates, so it says so rather than reusing " +
      "the credential wording.",
  },
  {
    id: "auth-device-trust-disabled",
    file: "apps/api/internal/auth/denials.go",
    fn: "writeDeviceTrustDisabledDenial",
    why:
      "The ONE ReasonFlag denial here with a real remedy: unlike " +
      "is_agency_account or the ops provisioning switch, an admin genuinely " +
      "can turn device trust on. Registered so that remedy cannot be dropped.",
  },
  {
    id: "campaign-summary-admin-required",
    file: "apps/api/internal/campaign_summary/campaign_summary.go",
    fn: "writeAdminRequiredDenial",
    why:
      "Names the role, so the client copy is right by construction rather than " +
      "by coincidence with the generic 'ask an administrator' fallback.",
  },
  {
    id: "affiliates-role",
    file: "apps/api/internal/affiliates/handlers.go",
    fn: "writeAffiliatesRoleDenial",
    why:
      "Code stays 'forbidden' because clients already match on it; what changes " +
      "is that the refusal now says WHICH role.",
  },
  {
    id: "events-topic-not-publishable",
    file: "apps/api/internal/events/handler.go",
    fn: "writeTopicNotPublishableDenial",
    why:
      "A product decision about which topics a browser may inject events into. " +
      "No role, plan or admin widens it, so the remedy is deliberately empty.",
  },
  {
    id: "marketplace-review-operator",
    file: "apps/api/internal/developer_marketplace/developer_marketplace.go",
    fn: "writeReviewOperatorRequiredDenial",
    why:
      "A Moosewave-side control, not a tenant entitlement — the approver is us, " +
      "so no role in the caller's workspace grants it.",
  },
  {
    id: "archive-tips-disabled",
    file: "apps/api/internal/archive/tips.go",
    fn: "PublicTipsCheckoutHandler",
    why:
      "The same class on a PUBLIC endpoint, which sharpens it: the reader " +
      "seeing this denial is not the person who can enable tips, so the remedy " +
      "is deliberately empty rather than an action they cannot take.",
  },
  {
    id: "nql-daily-cost-cap",
    file: "apps/api/internal/nql/denials.go",
    fn: "writeNLQCostCapDenial",
    why: "A resettable tenant NLQ usage window shared by analytics query and anomaly-brief routes.",
  },
  {
    id: "audit-nql-daily-cost-cap",
    file: "apps/api/internal/handlers/audit_nlq_denials.go",
    fn: "writeAuditNLQCostCapDenial",
    why: "The audit NLQ tenant usage window; clients need quota and Retry-After rather than generic rate-limit prose.",
  },
  {
    id: "forms-upload-workspace-quota",
    file: "apps/api/internal/forms/uploads.go",
    fn: "writeFormUploadQuotaDenial",
    why: "Workspace upload storage and pending-scan ceilings are product quotas, distinct from the public IP limiter.",
  },
  {
    id: "api-key-budget-window",
    file: "apps/api/internal/budgets/middleware.go",
    fn: "writeExceeded",
    why: "A caller-configured API-key usage budget with a known next-window retry time.",
  },
  {
    id: "mobile-test-push-window",
    file: "apps/api/internal/mobilepush/test_push.go",
    fn: "writeTestPushThrottledDenial",
    why: "A one-minute, per-device product throttle whose actionable remedy is to wait.",
  },
  {
    id: "webhook-playground-concurrency",
    file: "apps/api/internal/outbound_webhooks/playground_http_policy.go",
    fn: "writePlaygroundConcurrencyDenial",
    why: "A tenant-scoped simulator concurrency window with a deterministic five-second retry hint.",
  },
  {
    id: "consent-evidence-role",
    file: "apps/api/internal/consent/consent.go",
    fn: "requireExactAdminConsentSessionRole",
    why: "A genuine dashboard role refusal that must name the admin role instead of resembling CSRF or plan denial.",
  },
  {
    id: "api-tool-daily-quota",
    file: "apps/api/internal/apikeycalls/apikeycalls.go",
    fn: "QuotaMiddleware",
    why: "The release-held per-tool daily quota is entitlement-shaped before it can ever be re-enabled.",
  },
];

/**
 * Direct denials that must NOT use the product-entitlement envelope.
 *
 * The key is file + function, not a loose filename allowlist. That keeps a
 * security exception for one writer from silently excusing a new product
 * denial elsewhere in the package. `class` and `semantics` are closed
 * vocabularies checked below, and each entry must still correspond to a live
 * discovered emitter or the gate fails as stale.
 */
const EXEMPTIONS = [
  {
    id: "shopify-upstream-rate-limit",
    file: "apps/api/internal/commerce/handlers.go",
    fn: "writeShopifyBackfillError",
    class: "protocol",
    semantics: "upstream-provider",
    why: "Propagates Shopify's Retry-After transport response; it is not a Moosewave plan or workspace quota.",
  },
  {
    id: "audit-llm-upstream-rate-limit",
    file: "apps/api/internal/audit/nlq.go",
    fn: "TranslateLLMError",
    class: "protocol",
    semantics: "upstream-provider",
    why: "Classifies an upstream model-provider 429 for the HTTP adapter; the caller did not exhaust a Moosewave allowance.",
  },
  {
    id: "campaign-assurance-actor-authorization",
    file: "apps/api/internal/campaignassuranceapi/handlers.go",
    fn: "writeError",
    class: "security",
    semantics: "authorization-boundary",
    why: "Preserves object-level edit/action authorization without suggesting that billing or a retry can grant access.",
  },
  {
    id: "campaign-edit-lease-stable-identity",
    file: "apps/api/internal/campaigns/edit_lease_handlers.go",
    fn: "leaseRequestContext",
    class: "authentication",
    semantics: "credential-method",
    why: "An edit lease requires a stable human or key identity; it is an authentication precondition, not product access.",
  },
  {
    id: "editor-checkpoint-session",
    file: "apps/api/internal/editorcheckpoint/editorcheckpoint.go",
    fn: "identity",
    class: "authentication",
    semantics: "credential-method",
    why: "Per-person drafts cannot be safely shared by an API key, so the caller must use a session rather than upgrade.",
  },
  {
    id: "browser-event-ingest-rate-limit",
    file: "apps/api/internal/events/handler.go",
    fn: "Publish",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "A public ingestion anti-abuse bucket; its intentionally small response must not expose tenant entitlement state.",
  },
  {
    id: "forms-standard-sender-hourly-cap",
    file: "apps/api/internal/forms/handlers.go",
    fn: "resendFailure",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "The shared standard sender's hourly anti-abuse cap on confirmation emails is the same on every plan and lifts by verifying a sending domain, never by upgrading; it protects the platform sender's reputation, not a workspace allowance.",
  },
  {
    id: "audit-portal-origin",
    file: "apps/api/internal/handlers/audit_portal.go",
    fn: "Exchange",
    class: "security",
    semantics: "origin-boundary",
    why: "Rejects an untrusted browser Origin at a token exchange boundary and must remain an opaque security refusal.",
  },
  {
    id: "inbound-webhook-rate-limit",
    file: "apps/api/internal/inbound_webhooks/handlers.go",
    fn: "Ingest",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "Protects an unauthenticated webhook ingress bucket; exposing workspace product state would weaken the boundary.",
  },
  {
    id: "facebook-webhook-verify-token",
    file: "apps/api/internal/lead_integrations/facebook_lead_ads.go",
    fn: "FacebookLeadAdsWebhookChallenge",
    class: "security",
    semantics: "webhook-verification",
    why: "A provider challenge token mismatch must remain an opaque verification failure with no product remedy.",
  },
  {
    id: "mandate-human-grantor",
    file: "apps/api/internal/mandate/handlers.go",
    fn: "actor",
    class: "authentication",
    semantics: "credential-method",
    why: "An API key cannot be the human grantor of its own mandate; the caller must switch authentication method.",
  },
  {
    id: "admin-ip-allowlist",
    file: "apps/api/internal/middleware/admin_ip_allowlist.go",
    fn: "AdminIPAllowlistWithOptions",
    class: "security",
    semantics: "network-allowlist",
    why: "An administrative network allowlist must disclose neither matching rules nor any product entitlement guidance.",
  },
  {
    id: "authentication-bruteforce-limit",
    file: "apps/api/internal/middleware/auth_bruteforce.go",
    fn: "Middleware",
    class: "security",
    semantics: "authentication-rate-limit",
    why: "A credential-guessing limiter intentionally reveals no workspace allowance or account-specific remedy.",
  },
  {
    id: "api-key-rate-limit-middleware",
    file: "apps/api/internal/middleware/keyratelimit.go",
    fn: "Middleware",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "Standard API-key request throttling is an HTTP protocol boundary with Retry-After, not a feature entitlement.",
  },
  {
    id: "api-key-rate-limit-writer",
    file: "apps/api/internal/middleware/keyratelimit.go",
    fn: "writeKeyRateLimit",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "The shared API-key throttling writer preserves the established protocol envelope and retry headers.",
  },
  {
    id: "origin-csrf",
    file: "apps/api/internal/middleware/origin_csrf.go",
    fn: "AllowedOriginsCSRF",
    class: "security",
    semantics: "origin-boundary",
    why: "CSRF origin rejection must stay opaque and must never imply a role, plan, or retry can authorize the request.",
  },
  {
    id: "shared-ip-rate-limit",
    file: "apps/api/internal/middleware/ratelimit.go",
    fn: "Middleware",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "The generic IP bucket is transport abuse control and intentionally carries only standard retry semantics.",
  },
  {
    id: "tenant-request-rate-limit",
    file: "apps/api/internal/middleware/ratelimit_by_tenant.go",
    fn: "Middleware",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "A tenant request-frequency bucket is HTTP backpressure, not a product feature or paid-plan refusal.",
  },
  {
    id: "ops-write-csrf",
    file: "apps/api/internal/ops/auth.go",
    fn: "RequireWriteCSRF",
    class: "security",
    semantics: "origin-boundary",
    why: "The operations mutation CSRF check is an internal security boundary and remains deliberately non-actionable.",
  },
  {
    id: "ops-platform-operator",
    file: "apps/api/internal/ops/auth.go",
    fn: "RequirePlatformOperator",
    class: "authentication",
    semantics: "platform-operator",
    why: "This is a Moosewave platform-operator boundary, not a tenant role that a workspace administrator can grant.",
  },
  {
    id: "form-upload-ip-rate-limit",
    file: "apps/api/internal/forms/uploads.go",
    fn: "writeFormUploadIPRateLimit",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "The anonymous form-upload IP bucket stays separate from the entitlement-shaped workspace storage quotas.",
  },
  {
    id: "service-suite-stable-actor",
    file: "apps/api/internal/service_suite/service_suite.go",
    fn: "CreateInternalNote",
    class: "authentication",
    semantics: "stable-principal",
    why: "Internal notes require an attributable principal; changing plan or waiting cannot manufacture audit identity.",
  },
  {
    id: "sms-reply-domain-status",
    file: "apps/api/internal/sms/inbox.go",
    fn: "writeReplyContractError",
    class: "protocol",
    semantics: "domain-error-contract",
    why: "The SMS reply subsystem owns a closed status/code contract and mirrors its retry response without reclassification.",
  },
  {
    id: "sms-provider-tenant-binding",
    file: "apps/api/internal/sms/provider_webhooks.go",
    fn: "writeProviderBindingError",
    class: "security",
    semantics: "webhook-verification",
    why: "A provider receiver bound to another tenant is a cross-tenant webhook security failure and remains opaque.",
  },
  {
    id: "status-confirm-attempt-limit",
    file: "apps/api/internal/status/rss.go",
    fn: "Confirm",
    class: "security",
    semantics: "public-token-attempt-limit",
    why: "Repeated confirmation-token failures are public anti-abuse state, not a workspace quota or paid feature.",
  },
  {
    id: "freshchat-upstream-retry-classifier",
    file: "apps/api/internal/support_integrations/freshchat_webhook.go",
    fn: "writeFreshchatRefreshError",
    class: "protocol",
    semantics: "upstream-provider",
    why: "Maps an upstream Freshchat throttle to an accepted asynchronous retry, rather than refusing a product action.",
  },
  {
    id: "web-vitals-ip-rate-limit",
    file: "apps/api/internal/webvitals/handler.go",
    fn: "ServeHTTP",
    class: "protocol",
    semantics: "http-rate-limit",
    why: "Public telemetry ingestion uses an IP anti-abuse bucket and cannot safely reveal workspace product state.",
  },
];

/**
 * A denial envelope built by hand instead of through the contract.
 *
 * An earlier version matched only codes containing `limit|quota|plan`, so an
 * author writing `"cap_reached"` was invisible — and a review defeated the gate
 * five separate ways, including the site abandoning the package entirely for
 * `httperror.Write(w, 402, …)`, and the contract file itself being gutted to a
 * stub while the gate reported it "intact".
 *
 * The rule now: within the registered FUNCTION, any hand-rolled refusal — a map
 * literal with a `code` key, or a direct write of 402/403/429 — beside or
 * instead of the contract call.
 */
const HAND_BUILT = [
  /"code":\s*"[a-z_]+"/,
  /StatusPaymentRequired|StatusForbidden|StatusTooManyRequests/,
  // Numeric literals too. A review built a hand-made denial in a file-scope
  // helper using a bare `402` and the identifier check missed it entirely.
  /\bhttp\.StatusPaymentRequired\b|\bWriteHeader\(\s*(401|402|403|429)\s*\)/,
  // Narrowed to DENIAL statuses. Matching every httperror.Write made the gate
  // one ordinary refactor from a spurious failure: a helper writing a
  // legitimate 413 or 400 through the repo's standard error writer would fail
  // it, which is why two sites use a package-local writer instead — the guard
  // was shaping the code rather than checking it.
  /httperror\.Write\s*\(\s*w\s*,\s*http\.Status(PaymentRequired|Forbidden|TooManyRequests)\b/,
];

/**
 * Same-file functions a body calls, so the check follows one hop of indirection.
 *
 * Two bypasses a review DEMONSTRATED, both green before this existed:
 *
 *   - point the registered site at `httperror.Write` and leave the extracted
 *     contract helper orphaned. Go compiles unused functions, so the helper
 *     still contained the contract call and the register credited the file;
 *   - keep the contract call but `return` before it from a hand-built helper.
 *
 * Both defeat a check that asks where the contract call IS rather than whether
 * the denial path REACHES it. One hop is enough for the shapes seen in this
 * repo; deeper indirection is out of scope and stated as such below.
 */
function calledLocalFunctions(src, fnSrc) {
  const names = new Set();
  // Free functions AND method calls. The `[^.\w]` guard excluded anything
  // preceded by a dot, so `d.denyByHand(w)` was never followed — and every
  // handler in these packages is a method on *Deps, so a method is the
  // IDIOMATIC extraction. A review reproduced the byte-identical bypass in
  // both spellings: the free function was caught, the method was not.
  for (const m of fnSrc.matchAll(/(?:^|[^\w])\.?([a-z][A-Za-z0-9_]*)\s*\(/g)) {
    names.add(m[1]);
  }
  const bodies = [];
  for (const name of names) {
    // Only functions defined in the SAME file, and never the site itself.
    const body = functionBody(src, name);
    if (body && body !== fnSrc) bodies.push({ name, body });
  }
  return bodies;
}

/** The call that proves the site actually uses the contract. */
const CONTRACT_CALL = /entitlement\.(PlanLimit|Write|StatusFor|AsMap)\s*\(/;

/** Behaviour the contract file must still implement, not merely mention. */
const CONTRACT_BEHAVIOUR = [
  { re: /func\s+Write\s*\(\s*w\s+http\.ResponseWriter/, what: "Write(w http.ResponseWriter, …)" },
  { re: /func\s+PlanLimit\s*\(/, what: "the PlanLimit constructor" },
  { re: /if\s+!d\.Reason\.Valid\(\)\s*\{/, what: "the invalid-reason fallback in Write" },
  { re: /func\s+\(r\s+Reason\)\s+httpStatus\s*\(\)\s+int/, what: "the reason→status mapping" },
  { re: /StatusPaymentRequired/, what: "the 402 mapping for ReasonPlan" },
];

const read = (rel) => {
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
};

/**
 * Every non-test Go source in a file's PACKAGE, concatenated.
 *
 * A helper's callers live anywhere in its package, not only in its own file.
 * Extracting the shared denial writers into `denials.go` put every caller in a
 * sibling file, and the file-scoped caller search then reported four live,
 * called helpers as dead code. Package scope is also the correct bound: an
 * unexported Go identifier is reachable from its package and nowhere else.
 */
const readPackage = (rel) => {
  const dir = resolve(repoRoot, rel, "..");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
      .map((f) => readFileSync(resolve(dir, f), "utf8"));
  } catch {
    return [];
  }
};

/**
 * The body of a named Go function, comments stripped.
 *
 * File-scoped checking credited an `entitlement.` reference anywhere in the
 * file, so a regressed site passed on a sibling. Conservative brace counting: an
 * unbalanced brace inside a string ends the body early, which can only cause a
 * false FAILURE, never a false pass.
 */
function functionBody(src, name) {
  const stripped = stripComments(src);
  const re = new RegExp(`func\\s+(\\([^)]*\\)\\s*)?${name}\\s*\\(`);
  const m = re.exec(stripped);
  if (!m) return null;
  const open = stripped.indexOf("{", m.index);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < stripped.length; i += 1) {
    if (stripped[i] === "{") depth += 1;
    else if (stripped[i] === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(open, i + 1);
    }
  }
  return stripped.slice(open);
}

/** Comments stripped, so prose about the contract cannot satisfy a code check. */
function stripComments(src) {
  // LINE comments first, then block comments — the reverse order was wrong in a
  // way that silently ate code.
  //
  // `subject_lab.go` line 23 says `// ... same code as /api/v1/ai/compose/*.`
  // in a LINE comment. Scanning for block comments first, that `/*` opened one,
  // and it ran to the next `*/` eighty-seven lines later — swallowing the route
  // mounts in between. The guard then reported a live, mounted handler as
  // unreachable. Any file that merely MENTIONS a glob path in a comment was
  // being read with a hole in it.
  return src
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const DIRECT_STATUS_RE = /http\.Status(PaymentRequired|Forbidden|TooManyRequests)\b/g;
const DIRECT_STATUS_NAME = {
  PaymentRequired: "402",
  Forbidden: "403",
  TooManyRequests: "429",
};
const RESPONSE_SINK_RE =
  /(?:\.WriteHeader\s*\(|http\.Error\s*\(|httperror\.Write\s*\(|(?:^|[^\w])write[A-Z][A-Za-z0-9_]*\s*\()/m;
const NUMERIC_DENIAL_AT_SINK_RE =
  /(?:\.WriteHeader|http\.Error|httperror\.Write|(?:^|[^\w])write[A-Z][A-Za-z0-9_]*)\s*\([\s\S]{0,240}?\b(402|403|429)\b/g;

function matchingBrace(src, open) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote !== "") {
      if (quote !== "`" && escaped) {
        escaped = false;
        continue;
      }
      if (quote !== "`" && ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length - 1;
}

function goFunctions(src) {
  const clean = stripComments(src);
  const declaration = /func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const functions = [];
  for (const match of clean.matchAll(declaration)) {
    const open = clean.indexOf("{", match.index);
    if (open === -1) continue;
    const close = matchingBrace(clean, open);
    functions.push({
      fn: match[1],
      signature: clean.slice(match.index, open),
      body: clean.slice(open, close + 1),
      line: clean.slice(0, match.index).split("\n").length,
    });
  }
  return functions;
}

function productionGoSources() {
  const sources = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".go") || entry.name.endsWith("_test.go")) continue;
      sources.push({
        file: full.slice(repoRoot.length + 1),
        source: readFileSync(full, "utf8"),
      });
    }
  };
  walk(resolve(repoRoot, "apps/api"));
  return sources;
}

function discoverDirectDenials(fs) {
  const sources = fs.listGoSources?.() ?? productionGoSources();
  const discovered = [];
  for (const { file, source } of sources) {
    if (!file || file.endsWith("_test.go") || typeof source !== "string") continue;
    for (const fn of goFunctions(source)) {
      const statuses = new Set();
      for (const match of fn.body.matchAll(DIRECT_STATUS_RE)) {
        statuses.add(DIRECT_STATUS_NAME[match[1]]);
      }
      for (const match of fn.body.matchAll(NUMERIC_DENIAL_AT_SINK_RE)) {
        statuses.add(match[1]);
      }
      if (statuses.size === 0) continue;

      // A provider client may inspect an upstream 402/403/429 and call helpers
      // whose names begin with `write` (for example, writing a retry record).
      // That is not an HTTP denial emitted by this service. Require the
      // function to own (or return a closure that owns) a real response writer
      // before response-sink syntax can classify it as an emitter.
      const hasResponseWriter =
        /http\.ResponseWriter/.test(fn.signature) ||
        /http\.ResponseWriter/.test(fn.body);
      const hasResponseSink = hasResponseWriter && RESPONSE_SINK_RE.test(fn.body);
      // A status translator can be an emission boundary without owning the
      // ResponseWriter, but it necessarily returns an integer status. Do not
      // mistake an outbound client returning (*http.Response, error) after it
      // observed a provider 429 for one of our response translators.
      const returnsDenialStatus =
        /\bint\b/.test(fn.signature) &&
        fn.body
          .split("\n")
          .some(
            (line) =>
              /\breturn\b/.test(line) &&
              /(?:http\.Status(?:PaymentRequired|Forbidden|TooManyRequests)|\b(?:402|403|429)\b)/.test(line) &&
              !/(?:==|!=|>=|<=)/.test(line),
          );
      if (!hasResponseSink && !returnsDenialStatus) continue;

      discovered.push({
        file,
        fn: fn.fn,
        line: fn.line,
        statuses: [...statuses].sort(),
        directMap:
          /map\[string\](?:any|interface\s*\{\})\s*\{/.test(fn.body) &&
          /["`]code["`]\s*:/.test(fn.body),
      });
    }
  }
  return discovered;
}

const EXEMPTION_CLASSES = new Set(["security", "authentication", "protocol"]);
const EXEMPTION_SEMANTICS = new Set([
  "authentication-rate-limit",
  "authorization-boundary",
  "credential-method",
  "domain-error-contract",
  "http-rate-limit",
  "network-allowlist",
  "origin-boundary",
  "platform-operator",
  "public-token-attempt-limit",
  "stable-principal",
  "upstream-provider",
  "webhook-verification",
]);

function checkDirectDenialCoverage(fs) {
  const errors = [];
  const discovered = discoverDirectDenials(fs);
  const converted = new Set(CONVERTED.map((site) => `${site.file}:${site.fn}`));
  const exemptions = new Map();
  const ids = new Set();

  for (const exemption of EXEMPTIONS) {
    const key = `${exemption.file}:${exemption.fn}`;
    if (ids.has(exemption.id)) errors.push(`duplicate denial exemption id ${exemption.id}`);
    ids.add(exemption.id);
    if (exemptions.has(key)) errors.push(`duplicate denial exemption anchor ${key}`);
    exemptions.set(key, exemption);
    if (!EXEMPTION_CLASSES.has(exemption.class)) {
      errors.push(`${exemption.id}: invalid exemption class ${JSON.stringify(exemption.class)}`);
    }
    if (!EXEMPTION_SEMANTICS.has(exemption.semantics)) {
      errors.push(`${exemption.id}: invalid exemption semantics ${JSON.stringify(exemption.semantics)}`);
    }
    if (typeof exemption.why !== "string" || exemption.why.trim().length < 40) {
      errors.push(`${exemption.id}: exemption rationale must be at least 40 characters`);
    }
  }

  const liveExemptions = new Set();
  for (const site of discovered) {
    if (site.file === CONTRACT) continue;
    const key = `${site.file}:${site.fn}`;
    if (converted.has(key)) continue;
    const exemption = exemptions.get(key);
    if (exemption) {
      liveExemptions.add(key);
      continue;
    }
    errors.push(
      `unclassified direct denial ${site.file}:${site.line} (${site.fn}) emits ` +
        `${site.statuses.join("/")}${site.directMap ? " with a direct code map" : ""}. ` +
        `Use internal/entitlement for product state, or add a narrow security/authentication/protocol exemption.`,
    );
  }
  for (const [key, exemption] of exemptions) {
    if (!liveExemptions.has(key)) {
      errors.push(
        `${exemption.id}: stale exemption ${key}; no direct 402/403/429 emitter is discovered at that function.`,
      );
    }
  }
  return { errors, discovered };
}

export function checkDenials(fs) {
  const errors = [];

  const contract = fs.read(CONTRACT);
  if (contract === null) {
    errors.push(
      `${CONTRACT} is missing, so there is no shared denial contract to check ` +
        `against. Refusing to report conformance with a deleted authority.`,
    );
    return errors;
  }

  // The vocabulary is the client-visible half. Losing a class silently would
  // leave a surface unable to distinguish two situations it must present
  // differently.
  for (const reason of ["plan", "role", "flag", "quota", "policy", "runtime"]) {
    if (!contract.includes(`Reason = "${reason}"`)) {
      errors.push(
        `the denial vocabulary lost "${reason}". Every class exists because a ` +
          `client needs a DIFFERENT affordance for it; dropping one collapses ` +
          `two situations a user experiences differently.`,
      );
    }
  }
  // BEHAVIOUR, not string presence. A review gutted this file to a stub holding
  // only the six reason strings and the text of the validity check, and the
  // gate reported the contract "intact" — because it was grepping for the words
  // rather than the functions.
  for (const { re, what } of CONTRACT_BEHAVIOUR) {
    if (!re.test(contract)) {
      errors.push(
        `${CONTRACT} no longer implements ${what}. The vocabulary being present ` +
          `is not the contract; the behaviour is.`,
      );
    }
  }

  for (const site of CONVERTED) {
    const raw = fs.read(site.file);
    if (raw === null) {
      errors.push(
        `${site.id}: ${site.file} does not exist. A register entry pointing at ` +
          `a deleted file excuses nothing and hides the next gap.`,
      );
      continue;
    }
    const fnSrc = functionBody(raw, site.fn);
    if (fnSrc === null) {
      errors.push(
        `${site.id}: no function named "${site.fn}" in ${site.file}. The ` +
          `register names a function so the check reads THAT site rather than ` +
          `crediting an unrelated \`entitlement.\` reference elsewhere in the file.`,
      );
      continue;
    }
    // An UNEXPORTED registered helper must be REACHED, not merely present.
    //
    // The check followed calls FROM the registered function, which is the wrong
    // direction when the registered function IS the helper. A review pointed the
    // real denial path at `httperror.Write` and left `writeNoCreditsDenial`
    // orphaned: Go compiles unused functions, the helper still contained the
    // contract call, and the gate credited it while no request could reach it.
    // Reproduced, and this closes it.
    //
    // Scoped to unexported names on purpose. An exported function is reachable
    // from any package — `limits.WriteExceeded` is called from three of them —
    // so demanding an in-file caller would be a false failure. Handlers are
    // exported too and reached by route mounting rather than a call.
    const isExported = /^[A-Z]/.test(site.fn);
    if (!isExported) {
      // Comments stripped FIRST. This ran over the raw source, so
      // `// TODO: re-wire writeNoCreditsDenial(w)` satisfied the rule — a
      // review reproduced exactly that and the gate reported zero errors,
      // over the very bypass this check was added to close. Every other
      // check here strips comments precisely so prose cannot pass for code.
      // Package scope, not file scope: the callers of an extracted helper live
      // in sibling files.
      //
      // Stripped PER FILE and then joined, never joined and then stripped. A
      // `/*` in one file otherwise pairs with a `*/` in a later one and the
      // block-comment regex deletes everything between — which silently ate the
      // routeauth call sites and reported four live helpers as dead code. Same
      // class as the line-vs-block ordering bug above: a comment stripper that
      // reaches across a boundary it should not.
      const sources = fs.readPackage?.(site.file) ?? [raw];
      const source = (Array.isArray(sources) ? sources : [sources])
        .map((f) => stripComments(f ?? ""))
        .join("\n");
      const callers = new RegExp(`(?:^|[^.\\w])${site.fn}\\s*\\(`, "gm");
      const hits = [...source.matchAll(callers)].length;
      // ...or MOUNTED. An unexported handler is reached by being passed to a
      // router as a method value (`Post("/path", d.generate)`), never by being
      // called with parens, so the call rule alone reported a live route as
      // dead code. Reachability is the property; a call is only one of its two
      // shapes.
      const mounted = new RegExp(`\\.${site.fn}\\s*[,)\\n]`, "gm");
      const mountHits = [...source.matchAll(mounted)].length;
      // One hit is the declaration itself.
      if (hits <= 1 && mountHits === 0) {
        errors.push(
          `${site.id} (${site.file}:${site.fn}) is neither called nor mounted. A registered ` +
            `helper that nothing invokes still contains the contract call, so the ` +
            `gate credits it while the real denial path has moved elsewhere — ` +
            `exactly how a review defeated this check.`,
        );
        continue;
      }
    }

    const helpers = calledLocalFunctions(raw, fnSrc);
    // Reachability: the contract must be called by the site itself or by a
    // same-file helper the site actually calls. An orphaned helper containing
    // the call no longer counts.
    const reachesContract =
      CONTRACT_CALL.test(fnSrc) || helpers.some((h) => CONTRACT_CALL.test(h.body));
    if (!reachesContract) {
      errors.push(
        `${site.id} (${site.file}:${site.fn}) does not CALL the contract. ${site.why}\n` +
          `        A mention of \`entitlement.\` in a sibling function, a comment ` +
          `or a string literal is not use — a review regressed this site to ` +
          `httperror.Write and the gate stayed green.`,
      );
      continue;
    }
    // The hand-built scan covers the site AND the helpers it calls, so a
    // refusal cannot be hidden one hop away behind an early return.
    const scanned = [{ name: site.fn, body: fnSrc }, ...helpers];
    let flagged = false;
    for (const re of HAND_BUILT) {
      for (const target of scanned) {
        if (re.test(target.body)) {
          errors.push(
            `${site.id} (${site.file}:${site.fn}) builds a refusal by hand ` +
              `${target.name === site.fn ? "beside" : `in the helper ${target.name}(), reached from`} ` +
              `the contract call (matched ${re}). Two shapes for one refusal is ` +
              `the state this replaced, and the second is the copy that stops ` +
              `getting updated.`,
          );
          flagged = true;
          break;
        }
      }
      if (flagged) break;
    }
  }

  const directCoverage = checkDirectDenialCoverage(fs);
  errors.push(...directCoverage.errors);

  return errors;
}

// --- self-test --------------------------------------------------------------

const goFn = (name, body) =>
  `func ${name}(w http.ResponseWriter, err error) bool {\n\t${body}\n\treturn true\n}\n`;

const CONTRACT_SRC_PARTS = [
  'ReasonPlan Reason = "plan"',
  'ReasonRole Reason = "role"',
  'ReasonFlag Reason = "flag"',
  'ReasonQuota Reason = "quota"',
  'ReasonPolicy Reason = "policy"',
  'ReasonRuntime Reason = "runtime"',
  "if !d.Reason.Valid() {",
  "func Write(w http.ResponseWriter, d Denial) {",
  "func PlanLimit(subject, resource, tier, message string, limit, current int64) Denial {",
  "func (r Reason) httpStatus() int {",
  "return http.StatusPaymentRequired",
].join("\n");
const CONTRACT_SRC = CONTRACT_SRC_PARTS;

function fakeFs(over = {}) {
  const files = { [CONTRACT]: CONTRACT_SRC };
  for (const s of CONVERTED) {
    // An unexported site needs a caller in the fixture, because "converted" now
    // means REACHED as well as present — a registered helper nothing invokes is
    // how a review defeated this check.
    const caller = /^[A-Z]/.test(s.fn)
      ? ""
      : `\n\nfunc fixtureCaller(w http.ResponseWriter) { ${s.fn}(w) }\n`;
    // APPEND, not assign: several registered sites legitimately share one file
    // (the extracted `denials.go` writers), and overwriting left every site but
    // the last with no function to find.
    files[s.file] =
      (files[s.file] ?? "") +
      goFn(s.fn, "return entitlement.PlanLimit(a, b, c, d, 1, 2)") +
      caller;
  }
  for (const exemption of EXEMPTIONS) {
    const status = exemption.class === "protocol" ? "http.StatusTooManyRequests" : "http.StatusForbidden";
    files[exemption.file] =
      (files[exemption.file] ?? "") +
      goFn(exemption.fn, `w.WriteHeader(${status})`);
  }
  const read = (rel) => (rel in over ? over[rel] : (files[rel] ?? null));
  return {
    read,
    // The fake's "package" is every fixture file sharing a directory — same
    // rule as the real one, so a self-test case cannot pass on a scope the
    // production check does not use.
    readPackage: (rel) => {
      const dir = rel.slice(0, rel.lastIndexOf("/"));
      const merged = { ...files, ...over };
      return Object.entries(merged)
        .filter(([k]) => k.startsWith(`${dir}/`) && !k.endsWith("_test.go"))
        .map(([, v]) => v ?? "");
    },
    listGoSources: () =>
      Object.entries({ ...files, ...over })
        .filter(([file, source]) => file.endsWith(".go") && !file.endsWith("_test.go") && source !== null)
        .map(([file, source]) => ({ file, source })),
  };
}

function selfTest() {
  const site = CONVERTED[0];
  // The reachability rule applies only to UNEXPORTED helpers — an exported one
  // is reachable from any package, so demanding a local caller would be a false
  // failure. Cases about reachability therefore need an unexported site.
  const localSite = CONVERTED.find((c) => /^[a-z]/.test(c.fn)) ?? site;
  const cases = [
    {
      name: "a converted set still calling the contract passes",
      fs: fakeFs(),
      expect: (e) => e.length === 0,
    },
    {
      // A glob path in a LINE comment used to open a fake block comment that
      // ran to the next `*/`, deleting everything between — including the route
      // mount below. The guard then called a live handler unreachable.
      name: "a glob path in a comment does not eat the code beneath it",
      fs: fakeFs({
        [site.file]:
          "// mirrors the shape /api/v1/ai/compose/* returns.\n" +
          'func Mount(r chi.Router) { r.Post("/x", d.' + site.fn + ") }\n" +
          goFn(site.fn, "entitlement.Write(w, d)") +
          "\n/* ---------- helpers ---------- */\n",
      }),
      expect: (e) => e.length === 0,
    },
    {
      // A helper extracted into its own file has all its callers in siblings.
      // File-scoped searching called four live, called helpers dead code.
      name: "a helper called from a SIBLING file in the same package passes",
      fs: fakeFs({
        [localSite.file]: goFn(localSite.fn, "entitlement.Write(w, d)"),
        [localSite.file.replace(/[^/]+$/, "caller.go")]:
          `func Handler(w http.ResponseWriter) { ${localSite.fn}(w) }\n`,
      }),
      expect: (e) => e.length === 0,
    },
    {
      // Joining files and THEN stripping lets a `/*` in one file pair with a
      // `*/` in a later one, deleting everything between. That silently ate a
      // whole package's call sites.
      name: "a block comment in one file does not eat a caller in another",
      fs: fakeFs({
        // The opener is in the FIRST file and the closer in the SECOND, with
        // the caller between them — the arrangement that made joined-then-
        // stripped source delete the call.
        [localSite.file]: goFn(localSite.fn, "entitlement.Write(w, d)") + "\n/* opener\n",
        [localSite.file.replace(/[^/]+$/, "zz_caller.go")]:
          `func Handler(w http.ResponseWriter) { ${localSite.fn}(w) }\n*/\n`,
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a helper called from NOWHERE in the package is still caught",
      fs: fakeFs({
        [localSite.file]: goFn(localSite.fn, "entitlement.Write(w, d)"),
        [localSite.file.replace(/[^/]+$/, "caller.go")]:
          "func Handler(w http.ResponseWriter) { somethingElse(w) }\n",
      }),
      expect: (e) =>
        e.some(
          (x) =>
            x.includes(localSite.id) && x.includes("neither called nor mounted"),
        ),
    },
    // The five bypasses an adversarial review demonstrated against the first
    // version of this gate. Each one passed; each one must now fail.
    {
      name: "BYPASS: hand-built envelope with a code the old regex did not match",
      fs: fakeFs({
        [site.file]:
          goFn(site.fn, 'return map[string]any{"code": "cap_reached"}') +
          goFn("Unrelated", "entitlement.Write(w, d)"),
      }),
      expect: (e) => e.some((x) => x.includes("does not CALL the contract")),
    },
    {
      name: "BYPASS: contract referenced only in a SIBLING function",
      fs: fakeFs({
        [site.file]: goFn(site.fn, "return writeItByHand(w)") + goFn("Other", "entitlement.PlanLimit(a,b,c,d,1,2)"),
      }),
      expect: (e) => e.some((x) => x.includes("does not CALL the contract")),
    },
    {
      name: "BYPASS: site abandons the contract for httperror.Write",
      fs: fakeFs({
        [site.file]: goFn(site.fn, 'httperror.Write(w, 402, "plan_limit_exceeded", msg)'),
      }),
      expect: (e) => e.some((x) => x.includes("does not CALL the contract")),
    },
    {
      name: "BYPASS: hand-rolled status written BESIDE the contract call",
      fs: fakeFs({
        [site.file]: goFn(
          site.fn,
          "d := entitlement.PlanLimit(a,b,c,d,1,2); w.WriteHeader(http.StatusPaymentRequired)",
        ),
      }),
      expect: (e) => e.some((x) => x.includes("builds a refusal by hand")),
    },
    {
      name: "BYPASS: contract gutted to a stub that merely MENTIONS the vocabulary",
      fs: fakeFs({
        [CONTRACT]: [
          'ReasonPlan Reason = "plan"',
          'ReasonRole Reason = "role"',
          'ReasonFlag Reason = "flag"',
          'ReasonQuota Reason = "quota"',
          'ReasonPolicy Reason = "policy"',
          'ReasonRuntime Reason = "runtime"',
          "if !d.Reason.Valid() {",
        ].join("\n"),
      }),
      expect: (e) => e.some((x) => x.includes("no longer implements")),
    },
    {
      name: "the registered function disappearing is caught",
      fs: fakeFs({ [site.file]: goFn("SomethingElse", "entitlement.PlanLimit(a,b,c,d,1,2)") }),
      expect: (e) => e.some((x) => x.includes("no function named")),
    },
    {
      name: "losing a reason class is caught",
      fs: fakeFs({ [CONTRACT]: CONTRACT_SRC.replace('ReasonRole Reason = "role"', "") }),
      expect: (e) => e.some((x) => x.includes('lost "role"')),
    },
    {
      name: "a missing contract refuses to report conformance",
      fs: fakeFs({ [CONTRACT]: null }),
      expect: (e) => e.length === 1 && e[0].includes("Refusing to report conformance"),
    },
    {
      name: "a new unclassified direct denial fails closed",
      fs: fakeFs({
        "apps/api/internal/newfeature/handler.go":
          'func Deny(w http.ResponseWriter) { httperror.Write(w, http.StatusForbidden, "nope", "no") }',
      }),
      expect: (e) => e.some((x) => x.includes("unclassified direct denial") && x.includes("newfeature/handler.go")),
    },
    {
      name: "a bare numeric denial cannot evade classification",
      fs: fakeFs({
        "apps/api/internal/newfeature/numeric.go":
          'func Deny(w http.ResponseWriter) { writeJSON(w, 429, map[string]any{"error": map[string]any{"code": "slow"}}) }',
      }),
      expect: (e) => e.some((x) => x.includes("unclassified direct denial") && x.includes("direct code map")),
    },
    {
      name: "an upstream status comparison is not misclassified as an emitted denial",
      fs: fakeFs({
        "apps/api/internal/provider/client.go":
          "func retry(resp *http.Response) bool { return resp.StatusCode == http.StatusTooManyRequests }",
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "an outbound client returning a provider throttle error is not an emitter",
      fs: fakeFs({
        "apps/api/internal/provider/do.go":
          "func do(resp *http.Response) (*http.Response, error) {\n" +
          "  if resp.StatusCode == http.StatusTooManyRequests {\n" +
          '    return resp, fmt.Errorf("provider throttled (429)")\n' +
          "  }\n" +
          "  return resp, nil\n" +
          "}",
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "an exemption whose exact function anchor disappears is stale",
      fs: fakeFs({
        [EXEMPTIONS[0].file]: "func SomethingElse() {}",
      }),
      expect: (e) => e.some((x) => x.includes(EXEMPTIONS[0].id) && x.includes("stale exemption")),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const errors = checkDenials(c.fs);
    if (c.expect(errors)) console.log(`  ✓ ${c.name}`);
    else {
      failed += 1;
      console.error(`  ✗ ${c.name}\n      got: ${JSON.stringify(errors, null, 2)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n✗ entitlement-denial self-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n✓ entitlement-denial self-test: ${cases.length}/${cases.length} cases pass.`);
}

// --- entry point ------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const errors = checkDenials({ read, readPackage });
    if (errors.length > 0) {
      console.error("✗ entitlement denial check FAILED:\n");
      for (const e of errors) console.error(`  - ${e}`);
      console.error(
        `\nA refusal a client cannot classify is a refusal it has to guess at,\n` +
          `and the guess is what shows a paywall to someone who needs a role.`,
      );
      process.exit(1);
    }
    const coverage = checkDirectDenialCoverage({
      listGoSources: productionGoSources,
    });
    const direct = coverage.discovered.filter((site) => site.file !== CONTRACT);
    const converted = new Set(CONVERTED.map((site) => `${site.file}:${site.fn}`));
    const exemptions = new Set(EXEMPTIONS.map((site) => `${site.file}:${site.fn}`));
    const directConverted = direct.filter((site) =>
      converted.has(`${site.file}:${site.fn}`),
    ).length;
    const directExempt = direct.filter((site) =>
      exemptions.has(`${site.file}:${site.fn}`),
    ).length;
    const statusCounts = { "402": 0, "403": 0, "429": 0 };
    for (const site of direct) {
      for (const status of site.statuses) statusCounts[status] += 1;
    }
    console.log(
      `✓ entitlement denials: the shared contract is intact and ` +
        `${CONVERTED.length} converted site(s) still use it.\n` +
        `  Fail-closed source coverage: ${direct.length} direct emitter(s) classified ` +
        `(${directConverted} contract-registered, ${directExempt} explicit boundary exemptions); ` +
        `status anchors 402=${statusCounts["402"]}, 403=${statusCounts["403"]}, ` +
        `429=${statusCounts["429"]}.`,
    );
  }
}
