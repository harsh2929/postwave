// SPDX-License-Identifier: AGPL-3.0-only

// Package stepup decides which actions need a fresh possession proof, and how
// fresh.
//
// `auth_sessions.mfa_satisfied` is set once at login and never expires. The
// codebase already names the consequence, in internal/auth/recovery_codes.go:
// "a borrowed post-MFA session could otherwise mint codes forever". That
// comment sits on ONE endpoint, which solved it by demanding a TOTP inline and
// bypassing the session flag altogether.
//
// Solving it once per endpoint is how a security rule becomes N inconsistent
// copies — and the copies that matter are the ones nobody wrote, because the
// endpoint's author did not think of it. Rotating an API key, exporting every
// subscriber, and deleting a list are all still authorised by a flag that has
// been true since breakfast.
//
// So the policy lives here, in one table, and the middleware reads it. Adding a
// sensitive endpoint means adding a row, not remembering a pattern.
//
// WHAT THIS IS NOT: a second authorisation system. Step-up runs AFTER the
// normal role and scope checks and never grants anything — a person who may not
// rotate a key cannot rotate one by proving possession. It only asks somebody
// who is already permitted to show they are still there.
package stepup

import (
	"net/http"
	"strings"
	"time"
)

// Requirement is how fresh a proof an action needs.
type Requirement struct {
	// Action is the stable identifier a client uses to explain the prompt and
	// telemetry uses to count it.
	Action string
	// MaxAge is how recently the possession factor must have been proven.
	MaxAge time.Duration
	// Reason is shown to the person. Written for them, not for a log: "Confirm
	// it's you before rotating an API key" tells somebody what is happening and
	// why, which is the difference between a prompt they complete and one they
	// abandon.
	Reason string
}

// Never is the zero requirement: this action needs no step-up.
var Never = Requirement{}

// Required reports whether this requirement asks for anything.
func (r Requirement) Required() bool { return r.MaxAge > 0 }

// Freshness tiers.
//
// Two, deliberately. A menu of five would be argued about per endpoint and
// settle nowhere; the question that actually matters is "is this recoverable if
// it was not you".
const (
	// Immediate — the action is irreversible or hands over durable access.
	// Fifteen minutes is long enough to complete a multi-step flow and short
	// enough that a walked-away laptop has expired.
	Immediate = 15 * time.Minute
	// Session — the action is sensitive but reversible and visible in the audit
	// log. Twelve hours means once per working day, not once per click.
	Session = 12 * time.Hour
)

// policy maps a method + path template onto its requirement.
//
// Keyed on the ROUTE, not on a handler, so the rule is legible next to the
// route table and a reviewer can see the whole sensitive surface in one place.
// Templates use chi's `{name}` syntax and are matched segment-by-segment by
// `Match` — a policy keyed on `/api/v1/api-keys/abc` would protect exactly one
// key, which is why concrete paths are not accepted here.
var policy = map[string]Requirement{
	// Emergency archive removal is reversible and audit-visible, but it changes
	// a public surface immediately. Require a fresh proof from the current
	// working session; API-key callers remain governed by the route's admin scope.
	"POST /api/v1/campaigns/{id}/unpublish-archive": {
		Action: "archive.issue_unpublish", MaxAge: Session,
		Reason: "Confirm it's you before removing this issue from the public archive.",
	},
	"POST /api/v1/outbound-webhooks/{id}/playground/fire": {
		Action: "outbound_webhook.playground_fire", MaxAge: Session,
		Reason: "Confirm it's you before sending a live event to this webhook receiver.",
	},
	// Hands over durable, often long-lived access that outlives the session.
	"POST /api/v1/api-keys": {
		Action: "api_key.create", MaxAge: Immediate,
		Reason: "Confirm it's you before creating an API key.",
	},
	"POST /api/v1/api-keys/{id}/rotate": {
		Action: "api_key.rotate", MaxAge: Immediate,
		Reason: "Confirm it's you before rotating an API key.",
	},
	// Removes another person's access, or grants it.
	// THESE PATHS ARE THE ONES THAT EXIST, not the ones that read well.
	//
	// Four of the six entries here originally named routes this API does not
	// serve: `/api/v1/team/invites` (the real one is `/api/v1/workspace/invites`),
	// `/api/v1/team/members/{id}` (`/api/v1/workspace/members/{id}`),
	// `/api/v1/settings/security` (`/api/v1/security/settings` — the segments
	// are the other way round), and `POST /api/v1/subscribers/export` (the
	// export is `GET /api/v1/subscribers/export.csv`).
	//
	// Nothing failed, because a policy entry that matches no request simply
	// never fires. Two thirds of this control was decoration: it read as
	// protecting invites, member changes, security settings and subscriber
	// export, and could only ever have protected API keys. `TestEveryProtected
	// RouteExists` now checks each entry against the generated route manifest,
	// so a renamed route breaks the build instead of silently unprotecting the
	// action.
	"POST /api/v1/workspace/invites": {
		Action: "team.invite", MaxAge: Session,
		Reason: "Confirm it's you before inviting someone to this workspace.",
	},
	// PATCH, not DELETE. Removal is a role change on the membership row — the
	// API has no DELETE for it, which is exactly the kind of mismatch the
	// original entry hid.
	"PATCH /api/v1/workspace/members/{id}": {
		Action: "team.member_change", MaxAge: Session,
		Reason: "Confirm it's you before changing a teammate's access.",
	},
	"DELETE /api/v1/workspace/invites/{id}": {
		Action: "team.invite_revoke", MaxAge: Session,
		Reason: "Confirm it's you before revoking an invitation.",
	},
	// Takes the whole audience out of the building. Irreversible in the sense
	// that matters: once exported, it is gone. It is a GET, which does not make
	// it a read — it returns every subscriber's address as a file.
	"GET /api/v1/subscribers/export.csv": {
		Action: "subscribers.export", MaxAge: Immediate,
		Reason: "Confirm it's you before exporting subscriber data.",
	},
	// A tenant export is broader than the subscriber CSV: it can contain the
	// complete audience, campaigns, automations, events and consent history.
	// Protect both creation and the authenticated binary route. HEAD is the web
	// client's proof/readiness preflight before it lets the browser navigate to
	// the streaming GET.
	"POST /api/v1/exports": {
		Action: "tenant_export.create", MaxAge: Immediate,
		Reason: "Confirm it's you before preparing a workspace data export.",
	},
	"HEAD /api/v1/exports/{id}/download": {
		Action: "tenant_export.download_preflight", MaxAge: Immediate,
		Reason: "Confirm it's you before downloading workspace data.",
	},
	"GET /api/v1/exports/{id}/download": {
		Action: "tenant_export.download", MaxAge: Immediate,
		Reason: "Confirm it's you before downloading workspace data.",
	},
	// Compliance attestations and revocations append durable evidence that an
	// auditor may rely on. They are reversible through a later, separately
	// recorded decision, so a fresh working-session proof is proportionate.
	"POST /api/v1/compliance/programs/{framework}/attest": {
		Action: "compliance_program.attest", MaxAge: Session,
		Reason: "Confirm it's you before recording this compliance attestation.",
	},
	"POST /api/v1/compliance/programs/{framework}/revoke": {
		Action: "compliance_program.revoke", MaxAge: Session,
		Reason: "Confirm it's you before revoking this compliance attestation.",
	},
	// Subscriber identity and consent writes are durable, audited changes. A
	// working-session proof covers reversible profile edits; erasure and merge
	// are irreversible and therefore require an immediate proof. API-key
	// callers remain exempt in middleware and rely on their explicit scopes.
	"PATCH /api/v1/subscribers/{id}": {
		Action: "subscriber.profile_update", MaxAge: Session,
		Reason: "Confirm it's you before changing this subscriber profile.",
	},
	"DELETE /api/v1/subscribers/{id}": {
		Action: "subscriber.erase", MaxAge: Immediate,
		Reason: "Confirm it's you before permanently erasing this subscriber.",
	},
	"POST /api/v1/subscribers/{id}/suppress": {
		Action: "subscriber.suppress", MaxAge: Session,
		Reason: "Confirm it's you before suppressing this subscriber.",
	},
	"DELETE /api/v1/deliverability/suppressions/{email}": {
		Action: "subscriber.suppression_remove", MaxAge: Session,
		Reason: "Confirm it's you before removing this reviewed suppression.",
	},
	"POST /api/v1/suppressions/bulk-action": {
		Action: "subscriber.suppression_bulk_action", MaxAge: Session,
		Reason: "Confirm it's you before changing this reviewed suppression scope.",
	},
	"POST /api/v1/suppressions/mirror/{provider}": {
		Action: "subscriber.suppression_provider_sync", MaxAge: Session,
		Reason: "Confirm it's you before importing suppression evidence from this provider.",
	},
	"POST /api/v1/subscribers/{id}/aliases": {
		Action: "subscriber.alias_add", MaxAge: Session,
		Reason: "Confirm it's you before linking another identity to this subscriber.",
	},
	"DELETE /api/v1/subscribers/{id}/aliases/{alias_id}": {
		Action: "subscriber.alias_delete", MaxAge: Session,
		Reason: "Confirm it's you before unlinking this subscriber identity.",
	},
	"POST /api/v1/subscribers/{id}/emails": {
		Action: "subscriber.email_add", MaxAge: Session,
		Reason: "Confirm it's you before attaching another email address.",
	},
	"PATCH /api/v1/subscribers/{id}/emails/{email_id}": {
		Action: "subscriber.email_update", MaxAge: Session,
		Reason: "Confirm it's you before changing this email's consent or suppression state.",
	},
	"DELETE /api/v1/subscribers/{id}/emails/{email_id}": {
		Action: "subscriber.email_delete", MaxAge: Session,
		Reason: "Confirm it's you before removing this email address.",
	},
	"PATCH /api/v1/subscribers/{id}/channel-consents/{channel}": {
		Action: "subscriber.consent_update", MaxAge: Immediate,
		Reason: "Confirm it's you before recording this subscriber's consent decision.",
	},
	"POST /api/v1/subscribers/bulk/grant-consent": {
		Action: "subscriber.bulk_consent_grant", MaxAge: Immediate,
		Reason: "Confirm it's you before recording consent for this reviewed subscriber scope.",
	},
	"POST /api/v1/subscribers/bulk/revoke-consent": {
		Action: "subscriber.bulk_consent_revoke", MaxAge: Immediate,
		Reason: "Confirm it's you before revoking consent for this reviewed subscriber scope.",
	},
	"PUT /api/v1/subscribers/{id}/lifecycle": {
		Action: "subscriber.lifecycle_update", MaxAge: Session,
		Reason: "Confirm it's you before changing this subscriber's lifecycle stage.",
	},
	"PATCH /api/v1/subscribers/{id}/account": {
		Action: "subscriber.account_link", MaxAge: Session,
		Reason: "Confirm it's you before changing this subscriber's account link.",
	},
	"POST /api/v1/accounts": {
		Action: "subscriber.account_create", MaxAge: Session,
		Reason: "Confirm it's you before creating an account for subscriber profiles.",
	},
	"POST /api/v1/subscribers/{id}/federated-links": {
		Action: "subscriber.federation_link", MaxAge: Immediate,
		Reason: "Confirm it's you before linking this identity across workspace boundaries.",
	},
	"DELETE /api/v1/subscribers/{id}/federated-links/{parent_subscriber_id}": {
		Action: "subscriber.federation_unlink", MaxAge: Immediate,
		Reason: "Confirm it's you before removing this cross-workspace identity link.",
	},
	"POST /api/v1/merge/apply": {
		Action: "subscriber.merge", MaxAge: Immediate,
		Reason: "Confirm it's you before reviewing and permanently merging subscriber records.",
	},
	"GET /api/v1/sms/conversations.csv": {
		Action: "sms_inbox.export", MaxAge: Immediate,
		Reason: "Confirm it's you before exporting SMS conversation data.",
	},
	// Conversation workflow changes are reversible and audit-visible, but they
	// can hide customer messages, change ownership, or alter operator metadata.
	// Use the working-session tier; automatic mark-read remains outside this
	// list so merely opening a thread never prompts for possession proof.
	"POST /api/v1/sms/conversations/{phone}/snooze": {
		Action: "sms_inbox.snooze", MaxAge: Session,
		Reason: "Confirm it's you before snoozing an SMS conversation.",
	},
	"POST /api/v1/sms/conversations/{phone}/unsnooze": {
		Action: "sms_inbox.unsnooze", MaxAge: Session,
		Reason: "Confirm it's you before restoring a snoozed SMS conversation.",
	},
	"POST /api/v1/sms/conversations/{phone}/archive": {
		Action: "sms_inbox.archive", MaxAge: Session,
		Reason: "Confirm it's you before archiving an SMS conversation.",
	},
	"POST /api/v1/sms/conversations/{phone}/unarchive": {
		Action: "sms_inbox.unarchive", MaxAge: Session,
		Reason: "Confirm it's you before restoring an archived SMS conversation.",
	},
	"POST /api/v1/sms/conversations/{phone}/assign": {
		Action: "sms_inbox.assign", MaxAge: Session,
		Reason: "Confirm it's you before changing an SMS conversation assignment.",
	},
	"POST /api/v1/sms/conversations/{phone}/notes": {
		Action: "sms_inbox.notes", MaxAge: Session,
		Reason: "Confirm it's you before replacing internal SMS conversation notes.",
	},
	"POST /api/v1/sms/conversations/{phone}/tags": {
		Action: "sms_inbox.tag_add", MaxAge: Session,
		Reason: "Confirm it's you before adding an SMS conversation tag.",
	},
	"DELETE /api/v1/sms/conversations/{phone}/tags": {
		Action: "sms_inbox.tag_remove", MaxAge: Session,
		Reason: "Confirm it's you before removing an SMS conversation tag.",
	},
	"POST /api/v1/sms/conversations/bulk": {
		Action: "sms_inbox.bulk_state", MaxAge: Session,
		Reason: "Confirm it's you before changing multiple SMS conversations.",
	},
	// The per-list twin of the subscribers export, and the reason the entry
	// above was not sufficient on its own: list ids come back from
	// GET /api/v1/lists, which any viewer may call, so "export each list in
	// turn" reached the same addresses without ever touching a gated route.
	// Same PII, same gate.
	"GET /api/v1/lists/{id}/export.csv": {
		Action: "list.export", MaxAge: Immediate,
		Reason: "Confirm it's you before exporting list member data.",
	},
	// Incident records can contain sensitive breach context and each available
	// write is durable, admin-only, and audit-visible. They are reversible
	// workflow records rather than credential issuance, so the working-session
	// freshness tier is the proportionate gate. Closure and legal-evidence
	// mutations remain release-held by their handlers.
	"POST /api/v1/privacy/incidents": {
		Action: "privacy_incident.create", MaxAge: Session,
		Reason: "Confirm it's you before opening a privacy incident record.",
	},
	"POST /api/v1/privacy/incidents/{incident_id}/transition": {
		Action: "privacy_incident.transition", MaxAge: Session,
		Reason: "Confirm it's you before changing a privacy incident state.",
	},
	// Asset and reusable-content writes feed campaign rendering. Deletions of
	// assets, saved blocks, and reference collections have no restore endpoint,
	// so they use the immediate tier; reversible organisation/edit operations
	// use the working-session tier. API-key integrations remain exempt in the
	// middleware and rely on their explicit write scopes.
	"POST /api/v1/assets": {
		Action: "asset.upload", MaxAge: Session,
		Reason: "Confirm it's you before uploading an asset.",
	},
	"PATCH /api/v1/assets/{id}": {
		Action: "asset.edit", MaxAge: Session,
		Reason: "Confirm it's you before changing asset metadata.",
	},
	"DELETE /api/v1/assets/{id}": {
		Action: "asset.delete", MaxAge: Immediate,
		Reason: "Confirm it's you before permanently removing an asset.",
	},
	"POST /api/v1/assets/bulk-delete": {
		Action: "asset.bulk_delete", MaxAge: Immediate,
		Reason: "Confirm it's you before permanently removing multiple assets.",
	},
	"POST /api/v1/assets/folders": {
		Action: "asset_folder.create", MaxAge: Session,
		Reason: "Confirm it's you before creating an asset folder.",
	},
	"PATCH /api/v1/assets/folders/{id}": {
		Action: "asset_folder.rename", MaxAge: Session,
		Reason: "Confirm it's you before renaming an asset folder.",
	},
	"DELETE /api/v1/assets/folders/{id}": {
		Action: "asset_folder.delete", MaxAge: Session,
		Reason: "Confirm it's you before removing an asset folder.",
	},
	"PATCH /api/v1/assets/{id}/folder": {
		Action: "asset.move", MaxAge: Session,
		Reason: "Confirm it's you before moving an asset.",
	},
	"POST /api/v1/assets/{id}/tags": {
		Action: "asset.tag_add", MaxAge: Session,
		Reason: "Confirm it's you before changing asset tags.",
	},
	"DELETE /api/v1/assets/{id}/tags/{tag}": {
		Action: "asset.tag_remove", MaxAge: Session,
		Reason: "Confirm it's you before changing asset tags.",
	},
	"POST /api/v1/blocks/saved": {
		Action: "saved_block.create", MaxAge: Session,
		Reason: "Confirm it's you before creating a reusable content block.",
	},
	"PATCH /api/v1/blocks/saved/{id}": {
		Action: "saved_block.update", MaxAge: Session,
		Reason: "Confirm it's you before changing a reusable content block.",
	},
	"DELETE /api/v1/blocks/saved/{id}": {
		Action: "saved_block.delete", MaxAge: Immediate,
		Reason: "Confirm it's you before permanently deleting a reusable content block.",
	},
	"POST /api/v1/collections": {
		Action: "reference_collection.create", MaxAge: Session,
		Reason: "Confirm it's you before creating a reference collection.",
	},
	"PATCH /api/v1/collections/{id}": {
		Action: "reference_collection.update", MaxAge: Session,
		Reason: "Confirm it's you before changing a reference collection.",
	},
	"DELETE /api/v1/collections/{id}": {
		Action: "reference_collection.delete", MaxAge: Immediate,
		Reason: "Confirm it's you before permanently deleting a reference collection.",
	},
	// Custom-object schemas feed segments, flows, imports, and profile links.
	// Type deletion cascades all records/links, while the other writes are
	// version-bound and audit-visible. API-key integrations are exempt in the
	// middleware and continue to rely on the explicit admin scope.
	"POST /api/v1/custom-objects/types": {
		Action: "custom_object_type.create", MaxAge: Session,
		Reason: "Confirm it's you before creating a custom-object type.",
	},
	"PUT /api/v1/custom-objects/types/{id}": {
		Action: "custom_object_type.update", MaxAge: Session,
		Reason: "Confirm it's you before changing a custom-object schema.",
	},
	"DELETE /api/v1/custom-objects/types/{id}": {
		Action: "custom_object_type.delete", MaxAge: Immediate,
		Reason: "Confirm it's you before deleting a custom-object type and all of its records.",
	},
	"POST /api/v1/custom-objects/types/{id}/records": {
		Action: "custom_object_record.write", MaxAge: Session,
		Reason: "Confirm it's you before writing a custom-object record.",
	},
	"DELETE /api/v1/custom-objects/records/{id}": {
		Action: "custom_object_record.delete", MaxAge: Session,
		Reason: "Confirm it's you before deleting a custom-object record.",
	},
	// Warehouse connections can move or import tenant data and carry durable
	// credential references. Exact versions prevent stale writes; step-up
	// verifies that the authorised browser session is still possessed. API-key
	// callers remain exempt in middleware and rely on the explicit scopes.
	"POST /api/v1/warehouse/connections": {
		Action: "warehouse_connection.create", MaxAge: Session,
		Reason: "Confirm it's you before creating a warehouse connection.",
	},
	"POST /api/v1/warehouse/connections/{id}/pause": {
		Action: "warehouse_connection.pause", MaxAge: Session,
		Reason: "Confirm it's you before pausing a warehouse connection.",
	},
	"DELETE /api/v1/warehouse/connections/{id}": {
		Action: "warehouse_connection.disconnect", MaxAge: Immediate,
		Reason: "Confirm it's you before disconnecting this warehouse connection.",
	},
	"POST /api/v1/warehouse/connections/{id}/provider-cleanup/acknowledge": {
		Action: "warehouse_connection.cleanup_acknowledge", MaxAge: Session,
		Reason: "Confirm it's you before recording provider cleanup evidence.",
	},
	"PUT /api/v1/warehouse/connections/{id}/mappings/{source_object}": {
		Action: "warehouse_mapping.write", MaxAge: Session,
		Reason: "Confirm it's you before changing a warehouse import mapping.",
	},
	"POST /api/v1/warehouse/connections/{id}/runs": {
		Action: "warehouse_run.execute", MaxAge: Session,
		Reason: "Confirm it's you before executing a warehouse sync.",
	},
	"POST /api/v1/warehouse/runs/due": {
		Action: "warehouse_run.execute_due", MaxAge: Session,
		Reason: "Confirm it's you before executing due warehouse syncs.",
	},
	"POST /api/v1/warehouse/connections/{id}/streaming/ship": {
		Action: "warehouse_streaming.ship", MaxAge: Session,
		Reason: "Confirm it's you before shipping a streaming-export window.",
	},
	"POST /api/v1/warehouse/connections/{id}/reverse-etl-mappings": {
		Action: "warehouse_reverse_etl.mapping_write", MaxAge: Session,
		Reason: "Confirm it's you before changing a reverse-ETL mapping.",
	},
	"DELETE /api/v1/warehouse/connections/{id}/reverse-etl-mappings/{mapping_id}": {
		Action: "warehouse_reverse_etl.mapping_delete", MaxAge: Session,
		Reason: "Confirm it's you before deleting a reverse-ETL mapping.",
	},
	"POST /api/v1/warehouse/connections/{id}/reverse-etl-sync": {
		Action: "warehouse_reverse_etl.sync", MaxAge: Session,
		Reason: "Confirm it's you before writing warehouse traits to subscriber profiles.",
	},
	// ── THE MIRROR IMAGE OF THE BUG ABOVE ─────────────────────────────────
	// The block above records entries that named routes which did not exist,
	// so two thirds of this control was decoration. The defect these three fix
	// is the same failure in the other direction: REAL credential-minting
	// routes that no entry named. `TestEveryProtectedRouteExists` catches the
	// first kind and could never catch the second, because an unlisted route
	// is not a broken entry — it is an absent one.
	//
	// Each shipped after the API-key entries were written and each hands over
	// exactly what the stated criterion covers: "durable, often long-lived
	// access that outlives the session".
	//
	// A SCIM bearer provisions and DEPROVISIONS workspace users from the IdP
	// side — it can create and delete people.
	"POST /api/v1/scim/tokens": {
		Action: "scim_token.create", MaxAge: Immediate,
		Reason: "Confirm it's you before creating a SCIM provisioning token.",
	},
	// A mandate is delegated authority handed to an AGENT: a bearer that acts
	// on the workspace's behalf, bounded but real. The whole premise of the
	// surface is that a mandate traces to a PERSON (the handler refuses API
	// keys for exactly this reason), and step-up is what makes that person the
	// one actually present.
	"POST /api/v1/agent-mandates": {
		Action: "agent_mandate.create", MaxAge: Immediate,
		Reason: "Confirm it's you before granting an agent a mandate.",
	},
	// An HMAC signing key. Whoever holds it can write conversion events into
	// this workspace's attribution data indefinitely.
	"POST /api/v1/conversions/ingest-secrets": {
		Action: "conversion_secret.issue", MaxAge: Immediate,
		Reason: "Confirm it's you before issuing a conversion signing key.",
	},
	// Changes who can authenticate at all.
	"PUT /api/v1/security/settings": {
		Action: "security.settings", MaxAge: Immediate,
		Reason: "Confirm it's you before changing security settings.",
	},
}

// For returns the requirement for a route, or Never.
//
// `method` is upper-cased and `pattern` is the chi route TEMPLATE. Passing a
// concrete path is a caller error that returns Never — deliberately, because
// the alternative is a policy that silently half-matches and protects some ids
// and not others.
func For(method, pattern string) Requirement {
	key := strings.ToUpper(strings.TrimSpace(method)) + " " + strings.TrimSpace(pattern)
	return policy[key]
}

// Routes lists every protected route, for the contract test and for anything
// that needs to show a person which actions will prompt.
func Routes() []string {
	out := make([]string, 0, len(policy))
	for route := range policy {
		out = append(out, route)
	}
	return out
}

// Satisfied reports whether a proof given at provenAt is fresh enough now.
//
// A zero provenAt is NOT fresh. That is the un-backfilled session, and the
// honest answer for "we have no record of when you proved this" is to ask
// again — the alternative grants freshness that was never demonstrated.
func (r Requirement) Satisfied(provenAt time.Time, now time.Time) bool {
	if !r.Required() {
		return true
	}
	if provenAt.IsZero() {
		return false
	}
	return now.Sub(provenAt) <= r.MaxAge
}

// ErrorBody is the 401 a client renders a prompt from.
//
// Structured rather than a bare status, because "reauthenticate" with no action
// or reason forces every client to map the URL back to a human sentence — which
// is the same rule copied into three places, one of which will word it wrong.
type ErrorBody struct {
	Code       string `json:"code"`
	Action     string `json:"action"`
	Message    string `json:"message"`
	MaxAgeSecs int    `json:"max_age_seconds"`
}

// Body builds the response payload for an unsatisfied requirement.
func (r Requirement) Body() ErrorBody {
	return ErrorBody{
		Code:       "step_up_required",
		Action:     r.Action,
		Message:    r.Reason,
		MaxAgeSecs: int(r.MaxAge / time.Second),
	}
}

// StatusCode is 401, not 403.
//
// 403 says "you may not do this", which is false and sends somebody to an
// administrator about a permission they already have. 401 says "prove who you
// are", which is exactly the ask.
const StatusCode = http.StatusUnauthorized

// Match resolves the requirement for a concrete request path.
//
// Templates are matched segment by segment, with `{name}` matching exactly one
// segment. Deliberately strict: no prefix matching, no optional segments, no
// regex. A policy that half-matches is worse than none, because it reads as
// protection while covering an arbitrary subset — and this is the file where
// somebody will later add a route in a hurry.
func Match(method, path string) Requirement {
	method = strings.ToUpper(strings.TrimSpace(method))
	segments := splitPath(path)
	for route, req := range policy {
		space := strings.IndexByte(route, ' ')
		if space < 0 || route[:space] != method {
			continue
		}
		if matchTemplate(splitPath(route[space+1:]), segments) {
			return req
		}
	}
	return Never
}

func splitPath(p string) []string {
	p = strings.Trim(strings.TrimSpace(p), "/")
	if p == "" {
		return nil
	}
	return strings.Split(p, "/")
}

func matchTemplate(tmpl, got []string) bool {
	if len(tmpl) != len(got) {
		return false
	}
	for i, seg := range tmpl {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			// A parameter matches exactly one non-empty segment. An empty one
			// would let `/api-keys//rotate` match and protect a path no router
			// serves, which is noise rather than safety.
			if got[i] == "" {
				return false
			}
			continue
		}
		if seg != got[i] {
			return false
		}
	}
	return true
}
