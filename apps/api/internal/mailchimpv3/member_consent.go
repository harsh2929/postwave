package mailchimpv3

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httpcache"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

const mailchimpConsentPurpose = "email_marketing"

type memberConsentDecision struct {
	Requested bool
	Activate  bool
	Status    string
	Reason    string
	Purpose   string
	Evidence  *MemberConsentEvidence
}

// reviewMemberActivation treats Mailchimp status as lifecycle intent only.
// Activation requires an exact-address, purpose-bound evidence envelope; all
// incomplete or mismatched shapes remain review_required without returning a
// validation error that would discard the otherwise useful profile write.
func reviewMemberActivation(statusRaw, targetEmail string, evidence *MemberConsentEvidence) memberConsentDecision {
	if strings.TrimSpace(statusRaw) == "" {
		return memberConsentDecision{Status: "not_requested"}
	}
	if normalizeMailchimpStatus(statusRaw) != "subscribed" {
		return memberConsentDecision{Status: "not_requested"}
	}
	decision := memberConsentDecision{
		Requested: true,
		Status:    "review_required",
		Reason:    "complete_postwave_consent_evidence_required",
		Purpose:   mailchimpConsentPurpose,
	}
	if evidence == nil {
		return decision
	}
	normalized := *evidence
	boundEmail, err := normalizeMemberEmail(normalized.EmailAddress)
	if err != nil || boundEmail == "" {
		decision.Reason = "consent_evidence_email_invalid"
		return decision
	}
	targetEmail, err = normalizeMemberEmail(targetEmail)
	if err != nil || targetEmail == "" || !strings.EqualFold(boundEmail, targetEmail) {
		decision.Reason = "consent_evidence_email_mismatch"
		return decision
	}
	normalized.EmailAddress = boundEmail
	normalized.Purpose = strings.ToLower(strings.TrimSpace(normalized.Purpose))
	if normalized.Purpose != mailchimpConsentPurpose {
		decision.Reason = "consent_evidence_purpose_must_be_email_marketing"
		return decision
	}
	normalized.Source = strings.ToLower(strings.TrimSpace(normalized.Source))
	if normalized.Source != subscribers.ConsentDoubleOptIn && normalized.Source != subscribers.ConsentSingleOptIn {
		decision.Reason = "consent_evidence_source_must_be_reviewed_opt_in"
		return decision
	}
	normalized.Channel = strings.ToLower(strings.TrimSpace(normalized.Channel))
	switch normalized.Channel {
	case "web", "mobile", "desktop", "email", "import", "api":
	default:
		decision.Reason = "consent_evidence_channel_invalid"
		return decision
	}
	normalized.LegalBasis = strings.ToLower(strings.TrimSpace(normalized.LegalBasis))
	switch normalized.LegalBasis {
	case "consent", "contract", "legitimate_interest", "legal_obligation":
	default:
		decision.Reason = "consent_evidence_legal_basis_invalid"
		return decision
	}
	if normalized.OccurredAt == nil {
		decision.Reason = "consent_evidence_occurred_at_required"
		return decision
	}
	when := normalized.OccurredAt.UTC()
	if when.After(time.Now().UTC().Add(5 * time.Minute)) {
		decision.Reason = "consent_evidence_occurred_at_future"
		return decision
	}
	normalized.OccurredAt = &when
	normalized.Jurisdiction = strings.ToUpper(strings.TrimSpace(normalized.Jurisdiction))
	if normalized.Jurisdiction == "" || len(normalized.Jurisdiction) > 32 {
		decision.Reason = "consent_evidence_jurisdiction_required"
		return decision
	}
	normalized.Proof = strings.TrimSpace(normalized.Proof)
	if normalized.Proof == "" || len(normalized.Proof) > 2048 {
		decision.Reason = "consent_evidence_proof_required"
		return decision
	}
	normalized.Reason = strings.TrimSpace(normalized.Reason)
	if normalized.Reason == "" || len(normalized.Reason) > 500 {
		decision.Reason = "consent_evidence_reason_required"
		return decision
	}
	normalized.PolicyVersion = strings.TrimSpace(normalized.PolicyVersion)
	if normalized.PolicyVersion == "" || len(normalized.PolicyVersion) > 100 {
		decision.Reason = "consent_evidence_policy_version_required"
		return decision
	}

	decision.Activate = true
	// Persist review_required until the canonical transaction actually commits.
	// A successful read is projected as activated from canonical status; a
	// failed/crashed delegation therefore remains precise on later GETs instead
	// of leaving behind an optimistic "accepted" marker.
	decision.Status = "review_required"
	decision.Reason = "reviewed_evidence_accepted_canonical_activation_pending"
	decision.Evidence = &normalized
	return decision
}

func memberConsentActivity(decision memberConsentDecision, explicitStatus string) map[string]any {
	activity := map[string]any{"mailchimp_v3_facade": true}
	if decision.Requested {
		activity["mailchimp_consent_review"] = map[string]any{
			"status":  decision.Status,
			"reason":  decision.Reason,
			"purpose": decision.Purpose,
		}
		return activity
	}
	if strings.TrimSpace(explicitStatus) == "" {
		return activity
	}

	// An explicit negative/non-sendable lifecycle update must replace any old
	// activation marker in activity_summary. Otherwise a prior accepted proof
	// would make a later unsubscribe response look as though it were awaiting
	// activation even though the canonical row is already fail-closed.
	reviewStatus := "not_requested"
	reviewReason := "mailchimp_lifecycle_non_sendable"
	switch normalizeMailchimpStatus(explicitStatus) {
	case "pending":
		reviewStatus = "review_required"
		reviewReason = "complete_postwave_consent_evidence_required"
	case "unsubscribed", "deleted", "archived":
		reviewStatus = "revoked"
		reviewReason = "mailchimp_lifecycle_revoked"
	case "cleaned":
		reviewStatus = "blocked"
		reviewReason = "mailchimp_lifecycle_blocked"
	}
	activity["mailchimp_consent_review"] = map[string]any{
		"status":  reviewStatus,
		"reason":  reviewReason,
		"purpose": mailchimpConsentPurpose,
	}
	return activity
}

// activateReviewedMember delegates the positive transition to the canonical
// subscriber repository. That workflow atomically binds the current exact
// address, immutable consent event, structured proof, and email-marketing
// purpose projection. This compatibility package never writes those grants
// directly.
func (r *Repo) activateReviewedMember(ctx context.Context, tenantID, subscriberID string, evidence *MemberConsentEvidence) error {
	if evidence == nil || evidence.OccurredAt == nil {
		return subscribers.ErrInvalidInput
	}
	canonicalRepo := &subscribers.Repo{Pool: r.Pool}
	current, err := canonicalRepo.Get(ctx, tenantID, subscriberID)
	if err != nil {
		return err
	}
	if !strings.EqualFold(current.Email, evidence.EmailAddress) {
		return subscribers.ErrInvalidInput
	}
	status := subscribers.StatusEnabled
	mailchimpStatus := "subscribed"
	source := evidence.Source
	_, err = canonicalRepo.Update(ctx, tenantID, subscriberID, subscribers.UpdateInput{
		// The exact-address comparison above and this version precondition close
		// the transaction boundary between the compatibility profile write and
		// canonical activation. A concurrent address rotation or any other row
		// mutation makes activation fail closed instead of applying proof for the
		// previous address to the new delivery identity.
		IfMatchToken:         httpcache.ConcurrencyToken("subscriber", current.ID, current.UpdatedAt),
		Status:               &status,
		MailchimpStatus:      &mailchimpStatus,
		ConsentTimestamp:     evidence.OccurredAt,
		ConsentSource:        &source,
		ConsentChannel:       evidence.Channel,
		ConsentLegalBasis:    evidence.LegalBasis,
		ConsentJurisdiction:  evidence.Jurisdiction,
		ConsentEvidence:      evidence.Proof,
		ConsentReason:        evidence.Reason,
		ConsentPolicyVersion: evidence.PolicyVersion,
	})
	return err
}

func hydrateMemberConsentProjection(member *Member, canonicalStatus, mailchimpStatus string, activityRaw []byte) {
	if member == nil {
		return
	}
	member.CanonicalStatus = canonicalStatus
	member.Sendable = canonicalStatus == subscribers.StatusEnabled
	member.ConsentPurpose = mailchimpConsentPurpose
	if member.Sendable {
		member.ConsentReviewStatus = "activated"
		return
	}

	var activity map[string]any
	decodeJSONInto(activityRaw, &activity)
	if review, ok := activity["mailchimp_consent_review"].(map[string]any); ok {
		member.ConsentReviewStatus = strings.TrimSpace(stringValue(review, "status"))
		member.ConsentReviewReason = strings.TrimSpace(stringValue(review, "reason"))
		if purpose := strings.TrimSpace(stringValue(review, "purpose")); purpose != "" {
			member.ConsentPurpose = purpose
		}
	}
	if member.ConsentReviewStatus != "" {
		if member.ConsentReviewStatus == "activation_pending" {
			// A persisted pending activation is non-sendable until the canonical
			// workflow commits. Report review_required on reads/retries.
			member.ConsentReviewStatus = "review_required"
		}
		return
	}

	switch normalizeMailchimpStatus(mailchimpStatus) {
	case "pending":
		member.ConsentReviewStatus = "review_required"
		member.ConsentReviewReason = "complete_postwave_consent_evidence_required"
	case "unsubscribed", "deleted", "archived":
		member.ConsentReviewStatus = "revoked"
	case "cleaned":
		member.ConsentReviewStatus = "blocked"
	default:
		member.ConsentReviewStatus = "not_requested"
	}
}

func decodeJSONInto(raw []byte, target any) {
	if len(raw) == 0 || target == nil {
		return
	}
	_ = json.Unmarshal(raw, target)
}
