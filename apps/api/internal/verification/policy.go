// SPDX-License-Identifier: AGPL-3.0-only
//
// policy.go — where verification is ENFORCED, as opposed to merely
// available.
//
// The rest of this package is a capability you call deliberately. This
// file is the part that acts on its own, at signup time, so its
// defaults and failure modes matter more than its features.
//
// Two rules govern everything here:
//
//  1. DEFAULT OFF. Enabling verification changes who is allowed to
//     become a subscriber. That must be an explicit operator decision,
//     never a side effect of a deploy.
//
//  2. FAIL OPEN ON A TERMINAL OUTAGE. The gate is an optimisation, not a
//     correctness boundary. If the vendor is unreachable or out of credits,
//     the signup is ACCEPTED and the decision is flagged Degraded. A fresh
//     durable attempt already in progress is different: the caller gets a
//     retryable answer until its one possible paid outcome is known.
//     Refusing real customers because a third party is down is a far
//     worse outcome than admitting a few bad addresses — those we can
//     still catch later with bounce processing and spam_trap_guard.
//
// Note the asymmetry in rule 2: a terminal vendor failure fails open, but a
// verdict the FREE tier already reached on its own still stands. The
// local tier needs no third party to be correct, so an outage is no
// reason to discard what it proved.

package verification

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Enforcement modes.
const (
	// ModeOff performs no verification at the enforcement point.
	ModeOff = "off"
	// ModeLocal uses only the free tier: syntax, DNS/MX, disposable and role
	// checks. The built-in disposable corpus and functional-role signals are
	// advisory; only tenant-supplied disposable overrides are terminal. It makes
	// no vendor call and spends no provider credit; DNS resolution can still add
	// network latency.
	ModeLocal = "local"
	// ModeFull escalates to the configured vendor, spending one credit
	// per address the free tier cannot decide.
	ModeFull = "full"
)

// Policy is one verification_policy row.
type Policy struct {
	FormsMode           string   `json:"forms_mode"`
	FormsRejectStatuses []string `json:"forms_reject_statuses"`
	// FormsSuggestTypos is a POINTER so "omitted" is distinguishable
	// from "explicitly false". With a plain bool, Go's zero value would
	// mean any caller building a Policy literal without this field —
	// or any JSON client omitting it — would silently turn typo
	// suggestions OFF, even though both the DB default and the useful
	// default are ON. nil means "use the default (true)".
	FormsSuggestTypos *bool     `json:"forms_suggest_typos,omitempty"`
	ImportMode        string    `json:"import_mode"`
	UpdatedAt         time.Time `json:"updated_at,omitempty"`
}

// SuggestTypos resolves the tri-state into the effective setting.
func (p Policy) SuggestTypos() bool {
	return p.FormsSuggestTypos == nil || *p.FormsSuggestTypos
}

// BoolPtr is a small helper for building a Policy with an explicit
// false, which a bare literal cannot express.
func BoolPtr(v bool) *bool { return &v }

// DefaultPolicy is what an unconfigured tenant gets.
//
// The mode remains off until an operator explicitly enables it. Once enabled,
// the default rejection set is the complete terminal-F set. Functional B2B
// role mailboxes (sales@, support@) remain cautionary Unknown/Valid/CatchAll;
// role-ness alone never maps them to do_not_mail.
func DefaultPolicy() Policy {
	return Policy{
		FormsMode: ModeOff,
		FormsRejectStatuses: []string{
			string(StatusInvalid), string(StatusSpamtrap),
			string(StatusAbuse), string(StatusDoNotMail),
		},
		FormsSuggestTypos: BoolPtr(true),
		ImportMode:        ModeOff,
	}
}

// ValidateMode rejects anything outside the closed set.
func ValidateMode(mode string) error {
	switch mode {
	case ModeOff, ModeLocal, ModeFull:
		return nil
	default:
		return fmt.Errorf("verification: unknown mode %q (want %q, %q or %q)",
			truncate(mode, 40), ModeOff, ModeLocal, ModeFull)
	}
}

// Normalize fills blanks with defaults and validates.
func (p Policy) Normalize() (Policy, error) {
	out := p
	if strings.TrimSpace(out.FormsMode) == "" {
		out.FormsMode = ModeOff
	}
	if strings.TrimSpace(out.ImportMode) == "" {
		out.ImportMode = ModeOff
	}
	if err := ValidateMode(out.FormsMode); err != nil {
		return Policy{}, err
	}
	if err := ValidateMode(out.ImportMode); err != nil {
		return Policy{}, err
	}
	if len(out.FormsRejectStatuses) == 0 {
		out.FormsRejectStatuses = append([]string(nil), DefaultPolicy().FormsRejectStatuses...)
	}
	seen := make(map[Status]struct{}, len(out.FormsRejectStatuses))
	normalizedStatuses := make([]string, 0, len(out.FormsRejectStatuses))
	for _, s := range out.FormsRejectStatuses {
		status := Status(s)
		if !isRejectablePolicyStatus(status) {
			// Keep the established validation phrase so the HTTP boundary returns a
			// caller error, while making clear that `valid` is canonical evidence but
			// can never be configured as a rejection rule.
			return Policy{}, fmt.Errorf("verification: %q is not a valid status for rejection", truncate(s, 40))
		}
		if _, duplicate := seen[status]; duplicate {
			continue
		}
		seen[status] = struct{}{}
		normalizedStatuses = append(normalizedStatuses, string(status))
	}
	out.FormsRejectStatuses = normalizedStatuses
	return out, nil
}

func isRejectablePolicyStatus(status Status) bool {
	switch status {
	case StatusInvalid, StatusSpamtrap, StatusAbuse, StatusDoNotMail,
		StatusCatchAll, StatusUnknown:
		return true
	default:
		return false
	}
}

var errInvalidStoredVerificationPolicy = errors.New("verification: stored policy is invalid")

func normalizeStoredVerificationPolicy(policy Policy) (Policy, error) {
	normalized, err := policy.Normalize()
	if err != nil {
		// Stored policy text is operator-controlled and can predate the current
		// constraint. Never reflect it through a read or downstream signup gate.
		return Policy{}, errInvalidStoredVerificationPolicy
	}
	return normalized, nil
}

// rejects reports whether a verdict should refuse the signup.
func (p Policy) rejects(status Status) bool {
	for _, s := range p.FormsRejectStatuses {
		if Status(s) == status {
			return true
		}
	}
	return false
}

// Policy loads the tenant's enforcement policy, returning defaults
// when no row exists.
func (s *Store) Policy(ctx context.Context, tenantID string) (Policy, error) {
	if s.Pool == nil {
		return DefaultPolicy(), nil
	}
	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return DefaultPolicy(), err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p Policy
	err = tx.QueryRow(ctx,
		`SELECT forms_mode, forms_reject_statuses, forms_suggest_typos, import_mode, updated_at
		   FROM verification_policy WHERE tenant_id = $1::uuid`, tenantID).
		Scan(&p.FormsMode, &p.FormsRejectStatuses, &p.FormsSuggestTypos, &p.ImportMode, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultPolicy(), nil
	}
	if err != nil {
		return DefaultPolicy(), err
	}
	return normalizeStoredVerificationPolicy(p)
}

// SetPolicy upserts the enforcement policy.
func (s *Store) SetPolicy(ctx context.Context, tenantID string, p Policy) (Policy, error) {
	normalized, err := p.Normalize()
	if err != nil {
		return Policy{}, err
	}
	if s.Pool == nil {
		return normalized, nil
	}

	tx, err := db.WithTenant(ctx, s.Pool, tenantID)
	if err != nil {
		return Policy{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var out Policy
	err = tx.QueryRow(ctx,
		`INSERT INTO verification_policy
		     (tenant_id, forms_mode, forms_reject_statuses, forms_suggest_typos, import_mode)
		 VALUES ($1::uuid, $2, $3::text[], $4, $5)
		 ON CONFLICT (tenant_id) DO UPDATE
		    SET forms_mode            = EXCLUDED.forms_mode,
		        forms_reject_statuses = EXCLUDED.forms_reject_statuses,
		        forms_suggest_typos   = EXCLUDED.forms_suggest_typos,
		        import_mode           = EXCLUDED.import_mode,
		        updated_at            = now()
		 RETURNING forms_mode, forms_reject_statuses, forms_suggest_typos, import_mode, updated_at`,
		tenantID, normalized.FormsMode, normalized.FormsRejectStatuses,
		normalized.SuggestTypos(), normalized.ImportMode).
		Scan(&out.FormsMode, &out.FormsRejectStatuses, &out.FormsSuggestTypos,
			&out.ImportMode, &out.UpdatedAt)
	if err != nil {
		return Policy{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Policy{}, err
	}
	return out, nil
}

// --- the signup gate ---

// Decision is the gate's answer for one address.
type Decision struct {
	// Allow is the only field a caller must act on.
	Allow bool `json:"allow"`
	// Checked reports whether any verification actually ran, so
	// "allowed because policy is off" is distinguishable from
	// "allowed because we checked and it was fine".
	Checked bool `json:"checked"`
	// Degraded reports that the gate failed OPEN — verification was
	// requested but could not complete, and the address was admitted
	// unverified.
	Degraded bool `json:"degraded"`

	Status     Status    `json:"status,omitempty"`
	SubStatus  SubStatus `json:"sub_status,omitempty"`
	DidYouMean string    `json:"did_you_mean,omitempty"`
	Provider   string    `json:"provider,omitempty"`
	Billable   bool      `json:"billable"`
	// Retryable means no subscriber mutation may occur yet. The public form
	// adapter returns a transient 503 so the browser retains the exact attempt
	// id while a concurrent tenant-wide address reservation settles.
	Retryable bool `json:"-"`
	// Reason is safe to show to an anonymous visitor: no vendor names,
	// no internals.
	Reason string `json:"reason,omitempty"`
}

// chainOverride lets tests substitute the chain without a live vendor.
// Unexported: production always builds from stored config.
type chainBuilder func(ctx context.Context, tenantID string) (*Chain, error)

// GateSignup decides whether an address may become a subscriber.
//
// It NEVER returns a non-nil error for a verification failure — see the
// fail-open rule in the package comment. An error here means the caller
// itself is broken (no pool, bad tenant), and callers should treat even
// that as "allow".
func (s *Store) GateSignup(ctx context.Context, tenantID, email string) (Decision, error) {
	return s.GateSignupAttempt(ctx, tenantID, "", email, "", nil)
}

// GateSignupAttempt is safe for legacy/direct callers: without an explicit
// successful anti-abuse authorization it can never cross the paid boundary.
func (s *Store) GateSignupAttempt(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
) (Decision, error) {
	return s.GateSignupAuthorizedAttempt(
		ctx, tenantID, formID, email, attemptID, requestFingerprint, false,
	)
}

// GateSignupAuthorizedAttempt is the paid-safe hosted-form gate. Full-mode
// egress requires all three: a caller-minted attempt id, the SHA-256 form-intent
// fingerprint, and an explicit successful CAPTCHA/anti-abuse authorization.
// Missing proof deliberately degrades to local-only checks.
func (s *Store) GateSignupAuthorizedAttempt(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
	antiAbuseAuthorized bool,
) (Decision, error) {
	// Check the caller's exact bytes before TrimSpace. VT, FF, and C1 controls
	// are whitespace to Go and could otherwise disappear before local syntax
	// validation, allowing direct/legacy callers around the public handler's
	// paid-egress boundary check.
	if hasUnsafeControlText(email) {
		return Decision{
			Allow:     false,
			Checked:   true,
			Status:    StatusInvalid,
			SubStatus: SubStatusSyntaxInvalid,
			Reason:    rejectionReason(StatusInvalid, SubStatusSyntaxInvalid),
		}, nil
	}
	trimmed := strings.TrimSpace(email)
	if trimmed == "" {
		return Decision{
			Allow:     false,
			Checked:   true,
			Status:    StatusInvalid,
			SubStatus: SubStatusSyntaxInvalid,
			Reason:    rejectionReason(StatusInvalid, SubStatusSyntaxInvalid),
		}, nil
	}

	policy, err := s.Policy(ctx, tenantID)
	if err != nil {
		// Cannot read policy => cannot know we were asked to enforce.
		// Admit, do not block signups on our own storage problem.
		return Decision{Allow: true, Degraded: true}, nil
	}
	if policy.FormsMode == ModeOff {
		return Decision{Allow: true}, nil
	}
	if policy.FormsMode == ModeFull {
		if !antiAbuseAuthorized || strings.TrimSpace(attemptID) == "" ||
			strings.TrimSpace(formID) == "" || len(requestFingerprint) == 0 {
			return s.localOnlySignupDecision(ctx, trimmed, policy, true), nil
		}

		claim, beginErr := s.beginSignupAttempt(
			ctx, tenantID, formID, trimmed, attemptID, requestFingerprint,
		)
		if errors.Is(beginErr, ErrSignupAttemptInvalid) {
			return Decision{
				Allow: false, Checked: true, Status: StatusUnknown,
				Reason: "This submission attempt is invalid. Refresh the form and try again.",
			}, nil
		}
		if errors.Is(beginErr, ErrSignupAttemptMismatch) {
			return Decision{
				Allow: false, Checked: true, Status: StatusUnknown,
				Reason: "This submission changed after it was sent. Refresh the form and try again.",
			}, nil
		}
		if beginErr != nil {
			// Storage uncertainty must never lead to an unreceipted paid call.
			return s.localOnlySignupDecision(ctx, trimmed, policy, true), nil
		}
		if claim.Attempt.State != signupAttemptStatePending {
			d, replayErr := decisionFromSignupReceipt(claim.Attempt, trimmed)
			if replayErr != nil {
				return retryableSignupDecision(), nil
			}
			return d, nil
		}
		if !claim.IdentityOwner {
			identity := claim.Identity
			if identity.State == signupIdentityStatePending {
				var reclaimed bool
				identity, reclaimed, beginErr = s.recoverStaleSignupIdentity(
					ctx, tenantID, formID, trimmed, attemptID, requestFingerprint,
				)
				if beginErr == nil && reclaimed {
					return s.executeClaimedSignupAttempt(
						ctx, tenantID, formID, trimmed, attemptID, requestFingerprint, policy,
					)
				}
				if beginErr != nil || identity.State == signupIdentityStatePending {
					return retryableSignupDecision(), nil
				}
			}
			d, replayErr := decisionFromSignupIdentity(identity, trimmed, policy)
			if replayErr != nil {
				return retryableSignupDecision(), nil
			}
			terminalState := SignupAttemptAllowed
			if !d.Allow {
				terminalState = SignupAttemptBlocked
			}
			if identity.State == SignupAttemptAmbiguous {
				terminalState = SignupAttemptAmbiguous
			}
			if err := s.finishSignupAttempt(ctx, tenantID, formID, trimmed, attemptID,
				requestFingerprint, d, terminalState, policy.SuggestTypos()); err != nil {
				return retryableSignupDecision(), nil
			}
			return d, nil
		}

		return s.executeClaimedSignupAttempt(
			ctx, tenantID, formID, trimmed, attemptID, requestFingerprint, policy,
		)
	}

	chain, err := s.gateChain(ctx, tenantID, policy.FormsMode)
	if err != nil {
		return Decision{Allow: true, Degraded: true}, nil
	}

	result, err := chain.Verify(ctx, trimmed)
	if err != nil {
		if provider := chain.Name(); provider != ProviderLocal && provider != "unconfigured" {
			s.RecordProviderError(ctx, tenantID, provider, err)
		}
		// Vendor outage / credit exhaustion / auth failure. Fail open,
		// but keep whatever the FREE tier established on its own —
		// that verdict needed no third party to be correct.
		if local := s.localOnlyVerdict(ctx, trimmed); local.Status.Decisive() && policy.rejects(local.Status) {
			return Decision{
				Allow:      false,
				Checked:    true,
				Degraded:   true,
				Status:     local.Status,
				SubStatus:  local.SubStatus,
				DidYouMean: suggestionFor(policy, local),
				Provider:   ProviderLocal,
				Reason:     rejectionReason(local.Status, local.SubStatus),
			}, nil
		}
		return Decision{Allow: true, Checked: true, Degraded: true}, nil
	}

	d := Decision{
		Allow:      !policy.rejects(result.Status),
		Checked:    true,
		Status:     result.Status,
		SubStatus:  result.SubStatus,
		DidYouMean: suggestionFor(policy, result),
		Provider:   result.Provider,
		Billable:   result.Billable,
	}
	if !d.Allow {
		d.Reason = rejectionReason(result.Status, result.SubStatus)
	}
	if result.Billable {
		if err := s.RecordUsage(ctx, tenantID, chain.Name(),
			ChainStats{Total: 1, VendorVerified: 1, CreditsSpent: 1}); err != nil {
			observeVerificationUsagePersistenceFailure("signup")
			if s.Logger != nil {
				s.Logger.Error("verification: signup usage accounting unavailable",
					"tenant_id", tenantID, "form_id", formID)
			}
		}
	}
	return d, nil
}

func (s *Store) executeClaimedSignupAttempt(
	ctx context.Context,
	tenantID, formID, email, attemptID string,
	requestFingerprint []byte,
	policy Policy,
) (Decision, error) {
	chain, err := s.gateChain(ctx, tenantID, ModeFull)
	if err != nil {
		// Chain construction can fail before a vendor exists at all (for
		// example, provider configuration or secret resolution is unavailable).
		// That is still no reason to discard a terminal verdict the free tier can
		// prove without spending a credit. Persist that policy-neutral evidence
		// so exact retries and distinct attempts cannot admit the address while
		// the provider is down.
		if local := s.localOnlyVerdict(ctx, email); local.Status.Decisive() && policy.rejects(local.Status) {
			d := Decision{
				Allow:      false,
				Checked:    true,
				Degraded:   true,
				Status:     local.Status,
				SubStatus:  local.SubStatus,
				DidYouMean: suggestionFor(policy, local),
				Provider:   ProviderLocal,
				Reason:     rejectionReason(local.Status, local.SubStatus),
			}
			if finishErr := s.finishClaimedSignupAttempt(ctx, tenantID, formID, email, attemptID,
				requestFingerprint, d, SignupAttemptBlocked, policy.SuggestTypos()); finishErr != nil {
				return retryableSignupDecision(), nil
			}
			return d, nil
		}
		if finishErr := s.finishClaimedSignupAttempt(ctx, tenantID, formID, email, attemptID,
			requestFingerprint, Decision{}, SignupAttemptAmbiguous, policy.SuggestTypos()); finishErr != nil {
			return retryableSignupDecision(), nil
		}
		return ambiguousSignupDecision(), nil
	}

	results, _, err := chain.VerifyBatchWithDispatchHook(
		ctx,
		[]string{email},
		func(hookCtx context.Context, _ []string) error {
			return s.markSignupAttemptDispatched(
				hookCtx, tenantID, formID, email, attemptID, requestFingerprint,
			)
		},
	)
	if err != nil || len(results) != 1 {
		if provider := chain.Name(); err != nil && provider != ProviderLocal && provider != "unconfigured" {
			s.RecordProviderError(ctx, tenantID, provider, err)
		}
		if finishErr := s.finishClaimedSignupAttempt(ctx, tenantID, formID, email, attemptID,
			requestFingerprint, Decision{}, SignupAttemptAmbiguous, policy.SuggestTypos()); finishErr != nil {
			return retryableSignupDecision(), nil
		}
		return ambiguousSignupDecision(), nil
	}

	result := results[0]
	d := Decision{
		Allow:      !policy.rejects(result.Status),
		Checked:    true,
		Status:     result.Status,
		SubStatus:  result.SubStatus,
		DidYouMean: replayableSignupSuggestion(email, result.SubStatus, policy.SuggestTypos()),
		Provider:   result.Provider,
		Billable:   result.Billable,
	}
	if !d.Allow {
		d.Reason = rejectionReason(result.Status, result.SubStatus)
	}
	terminalState := SignupAttemptAllowed
	if !d.Allow {
		terminalState = SignupAttemptBlocked
	}
	if err := s.finishClaimedSignupAttempt(ctx, tenantID, formID, email, attemptID,
		requestFingerprint, d, terminalState, policy.SuggestTypos()); err != nil {
		// The provider may already have charged us. A still-pending durable row
		// fences every retry; ask the browser to retry the exact attempt instead
		// of admitting on a non-replayable outcome.
		return retryableSignupDecision(), nil
	}
	if result.Billable {
		if err := s.RecordUsage(ctx, tenantID, chain.Name(),
			ChainStats{Total: 1, VendorVerified: 1, CreditsSpent: 1}); err != nil {
			observeVerificationUsagePersistenceFailure("signup")
			if s.Logger != nil {
				s.Logger.Error("verification: signup usage accounting unavailable",
					"tenant_id", tenantID, "form_id", formID)
			}
		}
	}
	return d, nil
}

func (s *Store) localOnlySignupDecision(ctx context.Context, email string, policy Policy, degraded bool) Decision {
	local := s.localOnlyVerdict(ctx, email)
	d := Decision{
		Allow:      true,
		Checked:    true,
		Degraded:   degraded,
		Status:     local.Status,
		SubStatus:  local.SubStatus,
		DidYouMean: suggestionFor(policy, local),
		Provider:   ProviderLocal,
	}
	if local.Status.Decisive() && policy.rejects(local.Status) {
		d.Allow = false
		d.Reason = rejectionReason(local.Status, local.SubStatus)
	}
	return d
}

// gateChain builds the verifier for the requested mode.
//
// ModeLocal deliberately drops the vendor even when one is configured: the
// whole point is a no-credit gate. DNS/MX checks can still incur network
// latency.
func (s *Store) gateChain(ctx context.Context, tenantID, mode string) (*Chain, error) {
	var chain *Chain
	var err error
	if s.chainOverride != nil {
		chain, err = s.chainOverride(ctx, tenantID)
		if err != nil {
			return nil, err
		}
	} else if mode == ModeLocal {
		return &Chain{Local: s.localVerifier()}, nil
	} else {
		chain, err = s.BuildChain(ctx, tenantID)
		if err != nil {
			return nil, err
		}
	}
	if chain == nil {
		return nil, ErrNotConfigured
	}
	if mode == ModeLocal {
		return &Chain{Local: chain.Local, Cache: chain.Cache}, nil
	}
	// A full signup decision must either reach the mailbox provider or be
	// explicitly reported as degraded. Provider-level bulk degradation is an
	// operator convenience for non-interactive workloads and must never turn a
	// public signup outage into an apparently healthy local unknown.
	if chain.Vendor == nil {
		return nil, ErrNotConfigured
	}
	strict := *chain
	strict.DegradeOnVendorFailure = false
	return &strict, nil
}

// localOnlyVerdict re-runs just the free tier. Used on the fail-open
// path so a vendor outage does not discard what local checks proved.
func (s *Store) localOnlyVerdict(ctx context.Context, email string) Result {
	r, err := s.localVerifier().Verify(ctx, email)
	if err != nil {
		return Result{Status: StatusUnknown}
	}
	return r
}

func suggestionFor(p Policy, r Result) string {
	if !p.SuggestTypos() {
		return ""
	}
	return r.DidYouMean
}

// rejectionReason renders a verdict as a message safe to show an
// anonymous visitor on a public form.
//
// Deliberately never names the provider or mentions verification
// mechanics: the visitor cannot act on that, and it advertises both our
// vendor relationship and the fact that an address was probed.
func rejectionReason(status Status, sub SubStatus) string {
	switch {
	case sub == SubStatusPossibleTypo:
		return "That email address looks like it has a typo. Check the domain and try again."
	case sub == SubStatusSyntaxInvalid:
		return "Enter a valid email address and try again."
	case sub == SubStatusNoDNSEntries:
		return "That email domain does not accept mail. Check the address and try again."
	case sub == SubStatusDisposable:
		return "Temporary or disposable email addresses are not accepted. Use a permanent address."
	case sub == SubStatusRoleBased || sub == SubStatusRoleBasedCatchAll:
		return "Shared mailboxes are not accepted here. Use a personal address."
	case sub == SubStatusMailboxNotFound:
		return "That mailbox does not exist. Check the address and try again."
	}
	switch status {
	case StatusInvalid:
		return "That email address cannot receive mail. Check it and try again."
	case StatusSpamtrap, StatusAbuse:
		// Never tell a trap it was identified as one.
		return "That email address cannot be accepted. Use a different address."
	case StatusDoNotMail:
		return "That email address cannot be accepted. Use a different address."
	default:
		return "That email address could not be accepted. Check it and try again."
	}
}

// containsFold is a small case-insensitive substring helper used by
// the guard test that keeps provider names out of visitor-facing text.
func containsFold(haystack, needle string) bool {
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
