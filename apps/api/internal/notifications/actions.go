// SPDX-License-Identifier: AGPL-3.0-only
package notifications

// What a person can DO about a notification, decided by the server.
//
// Mobile push already carries actionable categories: `categoryForEvent` maps
// `approval.requested` onto the `approval` category, which is what puts Approve
// and Reject buttons on the lock screen. The in-app feed row carries a
// `deep_link` and nothing else. So the same notification offers two buttons on
// a phone and "open the page" in the desktop bell — not a styling difference,
// a capability one.
//
// WHY THE SERVER DECIDES. The alternative is each client switching on
// `event_type` to decide which buttons to draw, which is three copies of a rule
// that must agree with a fourth copy on the server deciding the push category.
// This codebase has the same shape recorded repeatedly: one rule with N
// hand-maintained copies is not one contract. Here the drift is worse than
// cosmetic, because a client that guesses wrong offers an action the API will
// refuse — a button that fails is worse than a button that is absent.
//
// WHAT AN ACTION IS NOT: a permission grant. Every action names an endpoint the
// caller must already be entitled to call, and the API re-checks on invocation.
// The server authoring the button does not authorise pressing it.

// ActionKind distinguishes something the client does locally from something it
// asks the API to do.
type ActionKind string

const (
	// ActionNavigate sends the person somewhere. Always safe to offer: the
	// destination re-checks entitlement on arrival.
	ActionNavigate ActionKind = "navigate"
	// ActionAPI invokes an endpoint. Offered only where the endpoint exists and
	// is idempotent enough to survive a double tap.
	ActionAPI ActionKind = "api"
)

// Action is one affordance on a notification.
type Action struct {
	// ID is stable across surfaces so a telemetry event or a mobile category
	// button and the desktop button are recognisably the same action.
	ID    string     `json:"id"`
	Label string     `json:"label"`
	Kind  ActionKind `json:"kind"`
	// Method and Path are set for ActionAPI. Path is a template resolved
	// against the notification's entity id by the client — the server does not
	// bake the id in, so one catalog entry serves every notification of a kind.
	Method string `json:"method,omitempty"`
	Path   string `json:"path,omitempty"`
	// Style is advisory: "danger" marks a destructive or negative action so a
	// client can render it distinctly without deciding which one that is.
	Style string `json:"style,omitempty"`
	// SideEffect states what invoking this action actually changes. §11.1 makes
	// it a precondition of registering an action type at all, and it gates
	// whether the action may be invoked from an email ticket. The zero value is
	// undeclared and therefore closed — see side_effect.go.
	SideEffect SideEffect `json:"side_effect"`
	// Primary marks the action a client should emphasise when it can only show
	// one. Exactly zero or one action per event is primary.
	Primary bool `json:"primary,omitempty"`
}

// PushCategory is the actionable-notification category a mobile client
// registers buttons against. Kept here, beside the actions, because the two are
// one decision: the category IS the mobile rendering of these actions, and
// deriving them separately is how a phone comes to offer buttons the bell does
// not.
type PushCategory = string

const (
	CategoryApproval PushCategory = "approval"
	CategorySecurity PushCategory = "security"
	CategoryEntity   PushCategory = "entity"
)

// eventActions is the catalog: one entry per event type that has actions beyond
// "open it".
//
// Deliberately small. An action is a promise that pressing it does something,
// so an entry is added when the endpoint exists — not when a button would look
// good. Everything absent falls through to the navigate-only default, which is
// what the feed row already did for every event.
var eventActions = map[string]struct {
	Category PushCategory
	Actions  []Action
}{
	"approval.requested": {
		Category: CategoryApproval,
		Actions: []Action{
			{ID: "approval.approve", Label: "Approve", Kind: ActionAPI,
				Method: "POST", Path: "/api/v1/approvals/{id}/approve", Primary: true,
				SideEffect: SideEffectRecordsIntent},
			{ID: "approval.reject", Label: "Reject", Kind: ActionAPI,
				Method: "POST", Path: "/api/v1/approvals/{id}/reject", Style: "danger",
				SideEffect: SideEffectRecordsIntent},
		},
	},
	// The escalation of a request is the same decision, so it carries the same
	// actions — a person chased about an approval must be able to act on it
	// from the chase, not just from the original.
	"approval.escalated": {
		Category: CategoryApproval,
		Actions: []Action{
			{ID: "approval.approve", Label: "Approve", Kind: ActionAPI,
				Method: "POST", Path: "/api/v1/approvals/{id}/approve", Primary: true,
				SideEffect: SideEffectRecordsIntent},
			{ID: "approval.reject", Label: "Reject", Kind: ActionAPI,
				Method: "POST", Path: "/api/v1/approvals/{id}/reject", Style: "danger",
				SideEffect: SideEffectRecordsIntent},
		},
	},
	// F15 retention.offer_available is deliberately absent. No production
	// producer emits that event and neither advertised portal endpoint is
	// mounted. Registering actions here would make the feed and mobile push
	// promise buttons that cannot safely execute. The dormant decline receipt
	// primitive may be certified independently, but catalog registration waits
	// for recipient-bound origination, public eligibility, purchase release /
	// refund semantics, and a mounted customer action surface.
	"auth.new_device_sign_in": {
		Category: CategorySecurity,
		Actions: []Action{
			// Navigate, not an API call. "This wasn't me" must land somewhere a
			// person can see every session and revoke deliberately — a one-tap
			// mass revocation from a notification is how someone locks
			// themselves out of a laptop by dismissing a banner.
			{ID: "security.review", Label: "Review devices", Kind: ActionNavigate,
				Path: "/app/settings/security/devices", Primary: true,
				SideEffect: SideEffectNone},
		},
	},
}

// ActionsForEvent returns the actions a notification of this event type offers.
//
// Never nil: an empty slice is the honest answer for an event with nothing to
// do beyond opening it, and a nil would serialise as `null` where clients
// expect a list.
func ActionsForEvent(eventType string) []Action {
	entry, ok := eventActions[eventType]
	if !ok || len(entry.Actions) == 0 {
		return []Action{}
	}
	out := make([]Action, len(entry.Actions))
	copy(out, entry.Actions)
	return out
}

// CategoryForEvent returns the mobile push category for this event type.
//
// The single source `mobilepush.categoryForEvent` now defers to, so a phone
// cannot offer buttons the feed row does not know about — which was the state
// this file was written to end.
func CategoryForEvent(eventType string) PushCategory {
	if entry, ok := eventActions[eventType]; ok && entry.Category != "" {
		return entry.Category
	}
	return CategoryEntity
}

// ActionEvents lists every event type the catalog knows.
//
// Exported so a consumer can enumerate the catalog without a second copy of its
// keys — `actionticket.KnownAction` needs to know which action ids exist, and
// the only honest source of that is this map.
func ActionEvents() []string {
	out := make([]string, 0, len(eventActions))
	for event := range eventActions {
		out = append(out, event)
	}
	return out
}
