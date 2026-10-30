// SPDX-License-Identifier: AGPL-3.0-only
//
// kickbox.go — the Kickbox v2 driver.
//
// Endpoints used:
//
//	GET {BaseURL}/v2/verify?email=&apikey=
//	GET {BaseURL}/v2/balance?apikey=
//
// Kickbox's vocabulary is narrower than the canonical one: four
// `result` values (deliverable / undeliverable / risky / unknown)
// carrying their real meaning in the accompanying boolean flags.
// "risky" in particular is three different verdicts wearing one label
// — a catch-all domain, a disposable domain, and a role mailbox are
// all "risky" — so the mapping has to read the flags, not just the
// result string. Collapsing them would throw away the distinction
// between "this domain accepts everything" and "do not mail this".
//
// Kickbox also has no synchronous batch endpoint (its bulk API is an
// asynchronous CSV upload with a different lifecycle), so VerifyBatch
// fans out over the single-address endpoint with bounded concurrency.

package verification

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// KickboxDefaultBaseURL is the public API host.
const KickboxDefaultBaseURL = kickboxOrigin

// kickboxBatchConcurrency bounds the fan-out. Kickbox rate-limits per
// key; opening a socket per address on a 1000-address batch is a
// reliable way to get throttled and to exhaust local file descriptors.
const kickboxBatchConcurrency = 8

// KickboxVerifier implements Verifier against Kickbox v2.
type KickboxVerifier struct {
	APIKey string
	Now    func() time.Time

	// testHooks is deliberately unexported and ignored outside a go test
	// binary. Production origins and transports are never tenant-configurable.
	testHooks *providerTestHooks
}

// Name implements Verifier.
func (k *KickboxVerifier) Name() string { return ProviderKickbox }

func (k *KickboxVerifier) baseURL() string {
	if providerTestHooksEnabled() && k.testHooks != nil && k.testHooks.baseURL != "" {
		return strings.TrimSuffix(k.testHooks.baseURL, "/")
	}
	origin, err := officialProviderOrigin(ProviderKickbox, providerPrimaryOrigin)
	if err != nil {
		panic(err)
	}
	return origin
}

func (k *KickboxVerifier) client() *http.Client {
	if providerTestHooksEnabled() && k.testHooks != nil && k.testHooks.client != nil {
		return k.testHooks.client
	}
	return productionProviderHTTPClient(ProviderKickbox)
}

func (k *KickboxVerifier) now() time.Time {
	if k.Now != nil {
		return k.Now()
	}
	return time.Now().UTC()
}

// kbResult is the wire shape.
type kbResult struct {
	Result     string   `json:"result"`
	Reason     string   `json:"reason"`
	Role       bool     `json:"role"`
	Free       bool     `json:"free"`
	Disposable bool     `json:"disposable"`
	AcceptAll  bool     `json:"accept_all"`
	DidYouMean string   `json:"did_you_mean"`
	Sendex     *float64 `json:"sendex"`
	Email      string   `json:"email"`
	User       string   `json:"user"`
	Domain     string   `json:"domain"`
	Success    *bool    `json:"success"`
	Message    string   `json:"message"`
}

// Verify implements Verifier.
func (k *KickboxVerifier) Verify(ctx context.Context, email string) (Result, error) {
	if strings.TrimSpace(k.APIKey) == "" {
		return Result{}, fmt.Errorf("kickbox: %w", ErrNotConfigured)
	}

	q := url.Values{}
	q.Set("email", email)
	q.Set("apikey", k.APIKey)

	body, err := providerGet(ctx, k.client(), k.baseURL()+"/v2/verify?"+q.Encode())
	if err != nil {
		return Result{}, fmt.Errorf("kickbox verify: %w", err)
	}

	var wire kbResult
	if err := json.Unmarshal(body, &wire); err != nil {
		return Result{}, fmt.Errorf("kickbox: malformed verify response: %w", ErrProviderPartialOutcome)
	}
	if err := kbEnvelopeError(wire); err != nil {
		return Result{}, err
	}
	if err := validateKBResult(wire, email); err != nil {
		return Result{}, err
	}
	return k.toResult(wire, email, body), nil
}

// VerifyBatch implements Verifier by bounded fan-out.
//
// Any per-address request failure makes the whole batch indeterminate. A
// timeout/5xx may happen after Kickbox accepted and charged the request, so
// converting it to an unbilled unknown would invite an unsafe retry and a
// duplicate charge. Successful partials are discarded until a durable
// reconciliation path can prove which requests settled.
func (k *KickboxVerifier) VerifyBatch(ctx context.Context, emails []string) ([]Result, error) {
	if strings.TrimSpace(k.APIKey) == "" {
		return nil, fmt.Errorf("kickbox: %w", ErrNotConfigured)
	}
	if len(emails) > MaxBatch {
		return nil, ErrBatchTooLarge
	}

	out := make([]Result, len(emails))
	var wg sync.WaitGroup

	// A credit-exhaustion or auth failure applies to every remaining
	// address, so it aborts the run instead of being recorded 1000
	// times.
	var fatal error
	var ambiguous error
	var successes atomic.Int64
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Allocate work only as a worker is ready to dispatch it. The gate also
	// serializes fatal-state publication with the next assignment, so once an
	// auth/credit rejection is known no queued address can race cancellation and
	// start another provider call. Jobs assigned before that response are the
	// bounded already-in-flight window.
	workers := kickboxBatchConcurrency
	if len(emails) < workers {
		workers = len(emails)
	}
	var dispatchMu sync.Mutex
	next := 0
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				dispatchMu.Lock()
				if fatal != nil || ambiguous != nil || runCtx.Err() != nil || next >= len(emails) {
					dispatchMu.Unlock()
					return
				}
				i := next
				next++
				dispatchMu.Unlock()

				email := emails[i]
				res, err := k.Verify(runCtx, email)
				if err != nil {
					dispatchMu.Lock()
					if isFatalProviderError(err) {
						if fatal == nil {
							fatal = err
						}
					} else if ambiguous == nil {
						// Do not retain the underlying error: even sanitized transport
						// layers may be replaced by test adapters, and net/http errors
						// commonly contain credential-bearing request URLs.
						ambiguous = fmt.Errorf("kickbox batch contains an indeterminate provider request: %w", ErrProviderUnavailable)
					}
					// Stop assigning queued work on the first failure of either class.
					// Calls already in flight are the bounded uncertainty window.
					cancel()
					dispatchMu.Unlock()
					out[i] = k.unavailable(email)
					return
				}
				out[i] = res
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if err := kickboxBatchOutcomeError(fatal, ambiguous, successes.Load()); err != nil {
		return nil, err
	}
	return out, nil
}

func kickboxBatchOutcomeError(fatal, ambiguous error, successes int64) error {
	// A fatal response is only a proven non-billable rejection when no other
	// request settled or became indeterminate. Fan-out means a neighboring
	// request can succeed (and consume a credit) before cancellation arrives.
	if ambiguous != nil {
		if fatal != nil {
			return errors.Join(ErrProviderPartialOutcome, ErrProviderUnavailable, fatal)
		}
		if successes > 0 {
			return errors.Join(ErrProviderPartialOutcome, ambiguous)
		}
		return ambiguous
	}
	if fatal != nil {
		if successes > 0 {
			return errors.Join(ErrProviderPartialOutcome, fatal)
		}
		return fatal
	}
	return nil
}

func (k *KickboxVerifier) unavailable(email string) Result {
	return Result{
		Email:     email,
		Status:    StatusUnknown,
		SubStatus: SubStatusProviderUnavailable,
		Provider:  ProviderKickbox,
		Billable:  false,
		CheckedAt: k.now(),
	}
}

// Credits implements Verifier.
func (k *KickboxVerifier) Credits(ctx context.Context) (int, error) {
	if strings.TrimSpace(k.APIKey) == "" {
		return 0, fmt.Errorf("kickbox: %w", ErrNotConfigured)
	}
	q := url.Values{}
	q.Set("apikey", k.APIKey)
	body, err := providerGet(ctx, k.client(), k.baseURL()+"/v2/balance?"+q.Encode())
	if err != nil {
		return 0, fmt.Errorf("kickbox balance: %w", err)
	}
	var resp struct {
		Balance *int   `json:"balance"`
		Success *bool  `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return 0, fmt.Errorf("kickbox: malformed balance response: %w", ErrProviderUnavailable)
	}
	if resp.Success == nil {
		return 0, fmt.Errorf("kickbox: balance response omitted success: %w", ErrProviderUnavailable)
	}
	if !*resp.Success {
		return 0, kbMessageError(resp.Message)
	}
	if resp.Balance == nil || *resp.Balance < 0 {
		return 0, fmt.Errorf("kickbox: balance response is missing or invalid: %w", ErrProviderUnavailable)
	}
	return *resp.Balance, nil
}

// toResult maps the wire shape onto the canonical Result.
func (k *KickboxVerifier) toResult(w kbResult, requested string, raw json.RawMessage) Result {
	email := NormalizeEmail(requested)
	_, requestedDomain, _ := splitAddress(email)
	didYouMean, _ := canonicalProviderSuggestion(w.DidYouMean)

	status, sub := kbClassify(w)

	res := Result{
		Email:       email,
		Status:      status,
		SubStatus:   sub,
		Domain:      requestedDomain,
		FreeEmail:   w.Free,
		RoleAccount: w.Role,
		Disposable:  w.Disposable,
		// Kickbox does not report MX separately; a deliverable or
		// catch-all verdict implies the domain accepts mail.
		MXFound:    status == StatusValid || status == StatusCatchAll,
		DidYouMean: didYouMean,
		Provider:   ProviderKickbox,
		Billable:   true,
		CheckedAt:  k.now(),
		Raw:        raw,
	}
	if w.Sendex != nil {
		// sendex is 0..1; the canonical Score is the 0..10 scale the
		// rest of the platform and ZeroBounce both speak.
		score := int(math.Round(*w.Sendex * 10))
		if score < 0 {
			score = 0
		}
		if score > 10 {
			score = 10
		}
		res.Score = &score
	}
	return res
}

// kbClassify collapses (result, reason, flags) into the canonical
// (Status, SubStatus).
//
// The flags are consulted BEFORE the result string for "risky",
// because that one label covers three materially different outcomes.
func kbClassify(w kbResult) (Status, SubStatus) {
	result := strings.ToLower(strings.TrimSpace(w.Result))
	sub := kbReasonSubStatus(w.Reason)

	switch result {
	case "deliverable":
		// A role flag is advisory in a B2B product. The provider explicitly
		// proved this mailbox deliverable, so keep Valid while preserving the
		// role sub-status for operator policy and UI.
		if w.Role {
			return StatusValid, SubStatusRoleBased
		}
		return StatusValid, SubStatusNone

	case "undeliverable":
		return StatusInvalid, sub

	case "risky":
		switch {
		case w.Disposable:
			return StatusDoNotMail, SubStatusDisposable
		case w.Role && w.AcceptAll:
			return StatusCatchAll, SubStatusRoleBasedCatchAll
		case w.AcceptAll:
			return StatusCatchAll, SubStatusAcceptAll
		case w.Role:
			// Role alone is not a hard invalid/safety signal. Keep it cautionary
			// and send-eligible after canonical consent/suppression enforcement.
			return StatusUnknown, SubStatusRoleBased
		case strings.EqualFold(w.Reason, "low_quality"):
			// Kickbox's low_quality covers complainers and trap-like
			// addresses. do_not_mail is the honest read: we are not
			// told it is a trap, only that mailing it is a bad idea.
			return StatusDoNotMail, SubStatusToxic
		default:
			return StatusUnknown, sub
		}

	default: // "unknown" and anything unrecognised
		return StatusUnknown, sub
	}
}

func validateKBResult(w kbResult, requested string) error {
	if NormalizeEmail(w.Email) == "" || NormalizeEmail(w.Email) != NormalizeEmail(requested) {
		return fmt.Errorf("kickbox: verify response address is missing or mismatched: %w",
			ErrProviderPartialOutcome)
	}
	switch strings.ToLower(strings.TrimSpace(w.Result)) {
	case "deliverable", "undeliverable", "risky", "unknown":
	default:
		return fmt.Errorf("kickbox: verify response result is missing or unsupported: %w",
			ErrProviderPartialOutcome)
	}
	if w.Sendex != nil && (math.IsNaN(*w.Sendex) || math.IsInf(*w.Sendex, 0) || *w.Sendex < 0 || *w.Sendex > 1) {
		return fmt.Errorf("kickbox: verify response sendex is outside its documented range: %w",
			ErrProviderPartialOutcome)
	}
	if err := validateKBSemantics(w); err != nil {
		return err
	}
	requestedLocal, _, _ := splitAddress(NormalizeEmail(requested))
	if w.User != "" {
		if err := validateProviderResultText("user", w.User, 64); err != nil ||
			strings.TrimSpace(w.User) != w.User || !strings.EqualFold(w.User, requestedLocal) {
			return invalidProviderResultField("user")
		}
	}
	status, subStatus := kbClassify(w)
	return validateProviderProjection(Result{
		Email:       w.Email,
		Status:      status,
		SubStatus:   subStatus,
		Domain:      w.Domain,
		FreeEmail:   w.Free,
		RoleAccount: w.Role,
		Disposable:  w.Disposable,
		DidYouMean:  w.DidYouMean,
		Provider:    ProviderKickbox,
	}, requested)
}

func validateKBSemantics(w kbResult) error {
	result := strings.ToLower(strings.TrimSpace(w.Result))
	reason, reasonOK := parseKBReason(w.Reason)
	if !reasonOK {
		return invalidProviderResultField("reason")
	}
	contradictory := false
	switch result {
	case "deliverable":
		// Both flags describe a materially different provider outcome. Picking
		// deliverable first would create a false A-grade result.
		contradictory = w.Disposable || w.AcceptAll ||
			!strings.EqualFold(strings.TrimSpace(w.Reason), "accepted_email")
	case "undeliverable":
		contradictory = w.AcceptAll || !oneOfSubStatus(reason,
			SubStatusSyntaxInvalid, SubStatusNoDNSEntries, SubStatusMailboxNotFound)
	case "risky":
		// Disposable is terminal while accept-all is inherently indeterminate;
		// the adapter must not silently choose one when the provider sent both.
		// Kickbox documents reason as explaining result, but independently
		// documents accept_all/role flags. Preserve the ordinary
		// accept_all+low_deliverability catch-all shape; reject flags paired with
		// a different terminal reason rather than discarding either signal.
		terminalFlagConflict := oneOfSubStatus(reason,
			SubStatusSyntaxInvalid, SubStatusNoDNSEntries,
			SubStatusMailboxNotFound, SubStatusToxic)
		contradictory = !oneOfSubStatus(reason, SubStatusToxic, SubStatusDoesNotAcceptMail) ||
			(w.Disposable && w.AcceptAll) ||
			((w.AcceptAll || w.Role) && terminalFlagConflict)
	case "unknown":
		contradictory = w.Disposable || w.AcceptAll ||
			!oneOfSubStatus(reason, SubStatusFailedSMTPConnection,
				SubStatusTimeoutExceeded, SubStatusServerDidNotRespond,
				SubStatusExceptionOccurred)
	}
	if contradictory {
		return invalidProviderResultField("status_semantics")
	}
	return nil
}

// kbReasonSubStatus maps Kickbox reasons onto the canonical codes.
func kbReasonSubStatus(reason string) SubStatus {
	subStatus, _ := parseKBReason(reason)
	return subStatus
}

func parseKBReason(reason string) (SubStatus, bool) {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "invalid_email":
		return SubStatusSyntaxInvalid, true
	case "invalid_domain":
		return SubStatusNoDNSEntries, true
	case "rejected_email":
		return SubStatusMailboxNotFound, true
	case "low_quality":
		return SubStatusToxic, true
	case "low_deliverability":
		return SubStatusDoesNotAcceptMail, true
	case "no_connect", "invalid_smtp":
		return SubStatusFailedSMTPConnection, true
	case "timeout":
		return SubStatusTimeoutExceeded, true
	case "unavailable_smtp":
		return SubStatusServerDidNotRespond, true
	case "unexpected_error":
		return SubStatusExceptionOccurred, true
	case "accepted_email":
		return SubStatusNone, true
	default:
		return SubStatusNone, false
	}
}

// kbEnvelopeError converts a success:false body into a typed error.
func kbEnvelopeError(w kbResult) error {
	if w.Success == nil {
		return fmt.Errorf("kickbox: verify response omitted success: %w", ErrProviderPartialOutcome)
	}
	if *w.Success {
		return nil
	}
	err := kbMessageError(w.Message)
	if strings.TrimSpace(w.Email) != "" || strings.TrimSpace(w.Result) != "" {
		return errors.Join(ErrProviderPartialOutcome, err)
	}
	return err
}

func kbMessageError(message string) error {
	msg := strings.TrimSpace(message)
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "balance"), strings.Contains(lower, "credit"),
		strings.Contains(lower, "insufficient"):
		return fmt.Errorf("kickbox: provider reported exhausted credits: %w", ErrNoCredits)
	case strings.Contains(lower, "api key"), strings.Contains(lower, "apikey"),
		strings.Contains(lower, "unauthorized"), strings.Contains(lower, "forbidden"):
		return fmt.Errorf("kickbox: provider rejected the credential: %w", ErrUnauthorized)
	case msg == "":
		return fmt.Errorf("kickbox: provider reported failure without a message: %w", ErrProviderUnavailable)
	default:
		return fmt.Errorf("kickbox: provider reported a request failure: %w", ErrProviderUnavailable)
	}
}

// isFatalProviderError reports whether an error applies to the whole
// run rather than to one address, so a batch aborts instead of
// repeating the same failure for every remaining item.
func isFatalProviderError(err error) bool {
	return errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized) ||
		errors.Is(err, ErrProviderAccountRejected) || errors.Is(err, ErrNotConfigured) ||
		errors.Is(err, ErrProviderPartialOutcome)
}
