// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// OutboxKindRecordSignup is the durable intent appended in the same
// transaction as every accepted public submission. Its handler
// (SignupAudience.RecordSubmitted) writes the canonical subscriber, the
// consent a single opt-in grants, the list memberships, and the Listmonk
// projection. Registered in the composition root.
const OutboxKindRecordSignup = "forms.signup.record"

// The signup-source values a public submission carries: the form half of the
// subscribers.signup_source vocabulary (migration 0303).
// form_submissions.signup_source is CHECK-constrained to them (migration 2049).
const (
	signupSourceHostedPage   = "hosted_page"
	signupSourceEmbeddedForm = "embedded_form"
)

// Consent record constants for form signups.
const (
	consentMethodSingleOptIn = "single_optin"
	consentMethodDoubleOptIn = "double_optin"
	// formSignupConsentPolicy versions the rules this package applies when it
	// decides that a submission is a request to subscribe (see
	// evaluateSignupConsent). Change it when those rules change.
	formSignupConsentPolicy = "form-signup-consent-v1"
	singleOptInReason       = "Single opt-in signup through a form."
	doubleOptInReason       = "Double opt-in signup through a form, confirmed through the emailed link."
	// maxEvidenceQuoteRunes bounds each tenant-authored string quoted in consent
	// evidence, which must stay within 2048 characters.
	maxEvidenceQuoteRunes = 300
)

// ErrTargetListNotFound is returned when a form targets a list that is not
// one of its workspace's lists: no list_id_map row maps the id under the
// form's tenant. Forms write to a Listmonk instance other workspaces share,
// so an id alone proves nothing about who owns the list.
var ErrTargetListNotFound = errors.New("forms: the target list is not one of the workspace's lists")

// TargetList is one list a submission joins: the Listmonk id the form's
// settings store, and the workspace's Moosewave list UUID it maps to.
type TargetList struct {
	EngineID int64
	ListID   string
}

// SignupIntent is the part of a public submission's audience write decided at
// submit time. It carries no personal data: the handler reloads the address
// and name from the submission row, so an erased or deleted submission takes
// them with it.
type SignupIntent struct {
	// EngineListIDs are the form's target lists (Listmonk ids from its
	// settings) when the visitor asked to be subscribed. They are resolved to
	// the workspace's lists inside the insert transaction; an id the workspace
	// does not own fails the insert with ErrTargetListNotFound.
	EngineListIDs []int64
	// Subscribe reports that the visitor asked to be subscribed.
	Subscribe bool
	// Consent is the email consent the submission itself grants (single
	// opt-in). nil while a double opt-in awaits confirmation, and when the
	// visitor did not ask to be subscribed.
	Consent *SignupConsentGrant
}

// SignupConsentGrant is consent evidence decided at submit time.
type SignupConsentGrant struct {
	Method     string    `json:"method"`
	OccurredAt time.Time `json:"occurred_at"`
	Evidence   string    `json:"evidence"`
}

// signupRecordPayload is the OutboxKindRecordSignup row.
type signupRecordPayload struct {
	TenantID     string              `json:"tenant_id"`
	FormID       string              `json:"form_id"`
	SubmissionID string              `json:"submission_id"`
	Subscribe    bool                `json:"subscribe"`
	Consent      *SignupConsentGrant `json:"consent,omitempty"`
}

// confirmPayload is the OutboxKindEnableListmonk row. Rows written before
// migration 2049 carry the address instead of the submission id.
type confirmPayload struct {
	TenantID     string `json:"tenant_id"`
	FormID       string `json:"form_id"`
	SubmissionID string `json:"submission_id,omitempty"`
	Email        string `json:"email,omitempty"`
}

// signupConsent is the visitor's consent decision at submit time.
type signupConsent struct {
	// Affirmed reports that the visitor asked to be subscribed.
	Affirmed bool
	// Evidence describes the affirmative act. Set only when Affirmed.
	Evidence string
}

// evaluateSignupConsent decides whether a submission asks to subscribe.
//
// The form builder's only checkbox is the consent checkbox ("I agree to
// receive emails." by default); it submits as the consent field. When the
// form has one, only a ticked checkbox is a request to subscribe: an operator
// who made it optional has said a visitor may submit without subscribing.
// When the form has none, submitting it is the request, unless the submission
// explicitly declines.
func evaluateSignupConsent(form *Form, in *SubmitInput) signupConsent {
	label, hasCheckbox := formConsentCheckbox(form.Structure)
	name := quoteEvidence(form.Name)
	switch {
	case hasCheckbox && consentChecked(in.Consent):
		return signupConsent{Affirmed: true, Evidence: fmt.Sprintf(
			"The visitor ticked the consent checkbox %s and submitted the form %s (form %s).",
			quoteEvidence(label), name, form.ID)}
	case hasCheckbox:
		return signupConsent{}
	}
	if action, recognized := consentAction(in.Consent); recognized && action == "denied" {
		return signupConsent{}
	}
	return signupConsent{Affirmed: true, Evidence: fmt.Sprintf(
		"The visitor submitted the form %s (form %s). It has no consent checkbox, so submitting it is the request to subscribe.",
		name, form.ID)}
}

// doubleOptInEvidence is the consent evidence for a confirmed double opt-in.
func doubleOptInEvidence(formName, formID string, submittedAt time.Time) string {
	return fmt.Sprintf(
		"The visitor submitted the form %s (form %s) at %s and then clicked the confirmation link emailed to this address.",
		quoteEvidence(formName), formID, submittedAt.UTC().Format(time.RFC3339))
}

// formConsentCheckbox returns the label of the form's consent checkbox, if the
// form has one.
func formConsentCheckbox(structure map[string]any) (label string, present bool) {
	raw, err := json.Marshal(structure)
	if err != nil {
		return "", false
	}
	var parsed struct {
		Fields []struct {
			Kind  string `json:"kind"`
			Label string `json:"label"`
		} `json:"fields"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", false
	}
	for _, field := range parsed.Fields {
		if field.Kind == "checkbox" {
			return strings.TrimSpace(field.Label), true
		}
	}
	return "", false
}

func quoteEvidence(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if runes := []rune(value); len(runes) > maxEvidenceQuoteRunes {
		value = string(runes[:maxEvidenceQuoteRunes]) + "…"
	}
	return fmt.Sprintf("%q", value)
}

// signupSourceFor classifies where a submission was made. A request whose
// browser origin is the hosted form host came from the hosted page, including
// the hosted page framed by a script or iframe embed. One from any other
// origin came from an HTML form the workspace embedded on its own site. A
// request that names no origin is taken to be the hosted page: only a foreign
// origin is evidence of an embed.
func signupSourceFor(r *http.Request, publicHostBase string) string {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" || origin == "null" {
		origin = strings.TrimSpace(r.Header.Get("Referer"))
	}
	submitted, err := url.Parse(origin)
	if origin == "" || err != nil || submitted.Host == "" {
		return signupSourceHostedPage
	}
	hosted, err := url.Parse(strings.TrimSpace(publicHostBase))
	if err != nil || hosted.Host == "" || strings.EqualFold(submitted.Host, hosted.Host) {
		return signupSourceHostedPage
	}
	return signupSourceEmbeddedForm
}

// resolveTargetListsInTx maps the form's Listmonk list ids to the tenant's
// Moosewave lists through list_id_map. tx must be bound to tenantID. Any id the
// tenant does not own fails with ErrTargetListNotFound; nothing is dropped
// silently, because a silently dropped list is a signup that looks recorded
// and never reaches anyone.
func resolveTargetListsInTx(ctx context.Context, tx pgx.Tx, tenantID string, engineIDs []int64) ([]TargetList, error) {
	if len(engineIDs) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
SELECT listmonk_bigint_id, postwave_uuid::text
  FROM list_id_map
 WHERE tenant_id = $1::uuid
   AND listmonk_bigint_id = ANY($2::bigint[])`, tenantID, engineIDs)
	if err != nil {
		return nil, fmt.Errorf("forms: resolve target lists: %w", err)
	}
	owned := make(map[int64]string, len(engineIDs))
	for rows.Next() {
		var engineID int64
		var listID string
		if err := rows.Scan(&engineID, &listID); err != nil {
			rows.Close()
			return nil, fmt.Errorf("forms: resolve target lists: %w", err)
		}
		owned[engineID] = listID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("forms: resolve target lists: %w", err)
	}
	out := make([]TargetList, 0, len(engineIDs))
	for _, engineID := range engineIDs {
		listID, ok := owned[engineID]
		if !ok {
			return nil, fmt.Errorf("%w (list %d)", ErrTargetListNotFound, engineID)
		}
		out = append(out, TargetList{EngineID: engineID, ListID: listID})
	}
	return out, nil
}
