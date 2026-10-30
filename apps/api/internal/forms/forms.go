// Package forms owns the embeddable signup-form admin + public submission
// surface. Lives in apps/api (gateway) — NOT in services/migration — per
// plan.md Phase 3 §"Forms".
//
// Public submission flow runs OUTSIDE tenant middleware (no auth). The
// /api/public/* group skips db.WithTenant and relies on the
// `form_submissions_public_lookup` permissive RLS policy + on slug-based
// form lookups (the `public_slug_lookup` policy lets us SELECT published
// forms with no app.tenant_id set).
package forms

import (
	"time"
)

// OptInMode is single | double.
type OptInMode string

const (
	OptInSingle OptInMode = "single"
	OptInDouble OptInMode = "double"
)

// Status of a form definition.
type Status string

const (
	StatusDraft     Status = "draft"
	StatusPublished Status = "published"
	StatusArchived  Status = "archived"
)

// SubmissionStatus mirrors the form_submissions.status check.
type SubmissionStatus string

const (
	SubmissionPending      SubmissionStatus = "pending"
	SubmissionConfirmed    SubmissionStatus = "confirmed"
	SubmissionUnsubscribed SubmissionStatus = "unsubscribed"
	// SubmissionReceived is a response that did not ask to subscribe: the
	// form's consent checkbox was left unticked (migration 2050). Nothing is
	// confirmed and nothing is joined.
	SubmissionReceived SubmissionStatus = "received"
)

// FormStepField describes a single input slot inside a multi-step form.
// Added in X3; old single-step forms migrate to a one-element Steps list.
type FormStepField struct {
	Key      string   `json:"key"`
	Label    string   `json:"label"`
	Type     string   `json:"type"`
	Required bool     `json:"required,omitempty"`
	Options  []string `json:"options,omitempty"`
}

// FormStep is one page of a multi-step form. A single-step form is just
// a list of length 1.
type FormStep struct {
	Title  string          `json:"title"`
	Fields []FormStepField `json:"fields"`
}

// Form mirrors the TS Form type — every field has a JSON tag matching the
// camelCase the admin app expects.
type Form struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenantId"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	OptInMode OptInMode `json:"optInMode"`
	// Structure + Settings are persisted as jsonb; we keep them as raw
	// generic maps here because the gateway treats them as pass-through
	// payloads. The admin app owns the schema.
	Structure map[string]any `json:"structure"`
	Settings  map[string]any `json:"settings"`
	// Steps is the X3 multi-step descriptor list. Empty means single-step;
	// the admin UI can render either shape.
	Steps     []FormStep `json:"steps"`
	StepCount int        `json:"stepCount"`
	Status    Status     `json:"status"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

// PublicForm is the deliberately small, allowlisted representation returned
// by the unauthenticated hosted-form lookup. Keep this separate from Form: the
// operator model contains tenant identity, timestamps, and delivery settings
// (for example target list IDs and confirmation-email copy) that a public
// renderer does not need.
type PublicForm struct {
	Slug      string         `json:"slug"`
	OptInMode OptInMode      `json:"optInMode"`
	Structure map[string]any `json:"structure"`
	Settings  PublicSettings `json:"settings"`
	Status    Status         `json:"status"`
}

// PublicSettings contains only values needed to render the hosted form.
// Submission routing, list membership, tags, and confirmation-email content
// remain server-side.
type PublicSettings struct {
	SuccessMessage string `json:"successMessage"`
	StyleClass     string `json:"styleClass,omitempty"`
}

// FormListItem extends Form with computed fields the list view needs.
type FormListItem struct {
	Form
	Submissions30d int `json:"submissions30d"`
	ConversionRate int `json:"conversionRate"` // 0..100
	// Visits30d is the hosted-form view count over the last 30 days
	// (A23, desktop audit 2026-06-10) — the SUM of form_visits daily
	// counters bumped by the public render routes. Gives the desktop a
	// real denominator for visit-weighted conversion instead of the
	// unweighted mean FormsStatStrip had to disclose. 0 for forms that
	// predate migration 0366 or have never been viewed.
	Visits30d int `json:"visits30d"`
}

// CreateInput is the body of POST /api/v1/forms.
type CreateInput struct {
	Name               string     `json:"name"`
	Slug               string     `json:"slug"`
	OptInMode          OptInMode  `json:"optInMode"`
	SuccessMessage     string     `json:"successMessage"`
	SuccessRedirectURL string     `json:"successRedirectUrl,omitempty"`
	Steps              []FormStep `json:"steps,omitempty"`
}

// UpdateInput is the body of PATCH /api/v1/forms/{id}. All fields optional.
type UpdateInput struct {
	Name         *string         `json:"name,omitempty"`
	Slug         *string         `json:"slug,omitempty"`
	OptInMode    *OptInMode      `json:"optInMode,omitempty"`
	Structure    *map[string]any `json:"structure,omitempty"`
	Settings     *map[string]any `json:"settings,omitempty"`
	Steps        *[]FormStep     `json:"steps,omitempty"`
	Status       *Status         `json:"status,omitempty"`
	IfMatchToken string          `json:"-"`
}

// AllowedTransition reports whether a status change is legal. We forbid
// going back to "draft" once "archived" — if you really want to revive an
// archived form, clone it. (Mirrors how Mailchimp/ConvertKit handle this.)
func AllowedTransition(from, to Status) bool {
	if from == to {
		return true
	}
	switch from {
	case StatusDraft:
		return to == StatusPublished || to == StatusArchived
	case StatusPublished:
		return to == StatusDraft || to == StatusArchived
	case StatusArchived:
		return false
	}
	return false
}
