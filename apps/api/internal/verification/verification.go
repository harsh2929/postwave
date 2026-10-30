// SPDX-License-Identifier: AGPL-3.0-only
//
// Package verification is the provider-agnostic email-verification
// layer: one canonical Result vocabulary, a Verifier interface, and
// drivers for the local (free, DNS-level) tier plus the third-party
// mailbox-probing vendors (ZeroBounce, Kickbox).
//
// # WHY THIS EXISTS AS AN ABSTRACTION RATHER THAN A FEATURE
//
// An ESP must not run SMTP `RCPT TO` probes from its own address
// space. Probing generates bounces attributed to the prober, gets the
// probing IPs listed on the very DNSBLs we monitor in
// services/deliverability/internal/reputation/blacklist, and is
// explicitly discouraged by every receiving provider. The sending
// role and the probing role are incompatible on shared infrastructure
// — see docs/lists-suppressions-2026-gap-analysis.md, which made this
// call and recommended integrating a third-party validator instead.
//
// That decision was made and then never carried out: the codebase had
// internal/email_validator (syntax + MX only) and no connector to any
// vendor. This package closes that loop.
//
// THE TWO TIERS
//
//	local   — free, unmetered, no network egress beyond DNS. Can
//	          DISPROVE an address from structural no-mail evidence or a
//	          narrowly recognized abuse desk, but can never PROVE one.
//	          Static disposable and functional-role signals remain
//	          advisory. Its best affirmative verdict is StatusUnknown.
//
//	vendor  — metered, one credit per address. Actually probes the
//	          mailbox and can return StatusValid / StatusCatchAll /
//	          StatusSpamtrap.
//
// Chain (chain.go) composes them: local runs first, and every address
// it can decide terminally short-circuits before a credit is spent.
// The measured savings depend on each tenant's actual list composition.
//
// # THE VOCABULARY IS ZEROBOUNCE-SHAPED ON PURPOSE
//
// Status/SubStatus mirror ZeroBounce's published response contract.
// Two reasons: it is the de-facto industry vocabulary that customers
// already have downstream logic written against, and it is a superset
// of Kickbox's, so mapping Kickbox up loses nothing while mapping
// ZeroBounce down would.
package verification

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Provider identifiers. These are persisted in verification_providers
// and returned in Result.Provider, so they are a stable contract.
const (
	ProviderLocal      = "local"
	ProviderZeroBounce = "zerobounce"
	ProviderKickbox    = "kickbox"
)

// CreditsUnmetered is returned by Verifier.Credits for providers that
// have no notion of a balance (the local tier).
const CreditsUnmetered = -1

// Status is the canonical top-level verdict.
type Status string

const (
	// StatusValid — the mailbox was probed and accepted mail.
	// Only a vendor tier can produce this.
	StatusValid Status = "valid"
	// StatusInvalid — the address cannot receive mail. Terminal.
	StatusInvalid Status = "invalid"
	// StatusCatchAll — the domain accepts all recipients, so
	// per-mailbox existence is unknowable by probing. Vendors attach
	// an AI Score here; that score is the only signal available.
	StatusCatchAll Status = "catch_all"
	// StatusSpamtrap — a known trap address. Sending to it damages
	// sender reputation directly. Terminal, and the highest-value
	// verdict in the whole contract: it is the one thing our
	// post-hoc spam_trap_guard cannot give us, because that package
	// only reacts after a trap has already been hit.
	StatusSpamtrap Status = "spamtrap"
	// StatusAbuse — a known complainer / abuse address. Terminal.
	StatusAbuse Status = "abuse"
	// StatusDoNotMail — deliverable but should not be mailed: disposable,
	// toxic, or provider/global-suppression evidence. Role mailboxes alone are
	// advisory in a B2B product and remain Unknown/Valid/CatchAll with a flag.
	StatusDoNotMail Status = "do_not_mail"
	// StatusUnknown — could not be determined. The local tier's
	// ceiling; for vendors it means a transient probe failure.
	StatusUnknown Status = "unknown"
)

// AllStatuses is the closed set, used to validate persisted rows and
// reject an unmapped vendor string rather than silently storing it.
var AllStatuses = []Status{
	StatusValid, StatusInvalid, StatusCatchAll, StatusSpamtrap,
	StatusAbuse, StatusDoNotMail, StatusUnknown,
}

// Valid reports whether s is a member of the closed set.
func (s Status) Valid() bool {
	for _, known := range AllStatuses {
		if s == known {
			return true
		}
	}
	return false
}

// Decisive reports whether this verdict is terminal — i.e. no further
// (paid) verification could change the send/don't-send decision.
//
// StatusValid is deliberately NOT decisive here. That reads backwards
// until you remember who asks: only the local tier calls this to
// decide whether to skip the paid tier, and the local tier can never
// legitimately produce StatusValid. Treating it as non-decisive means
// that if a future local heuristic ever over-claims, the failure mode
// is "we spend a credit we didn't need" rather than "we mail an
// address nobody actually verified".
func (s Status) Decisive() bool {
	switch s {
	case StatusInvalid, StatusDoNotMail, StatusAbuse, StatusSpamtrap:
		return true
	default:
		return false
	}
}

// Sendable reports whether an address with this verdict should be
// included in a send. Callers gating a campaign audience use this
// rather than switching on Status themselves, so the policy lives in
// exactly one place.
//
// StatusCatchAll and StatusUnknown are sendable: excluding every
// catch-all domain would drop most B2B lists wholesale. Callers that
// want to be stricter filter on Score (see Result.Score).
func (s Status) Sendable() bool {
	switch s {
	case StatusValid, StatusCatchAll, StatusUnknown:
		return true
	default:
		return false
	}
}

// SubStatus is the fine-grained reason code. The set mirrors
// ZeroBounce's published sub_status vocabulary, plus a small number of
// Moosewave-specific codes for states no vendor reports.
type SubStatus string

const (
	SubStatusNone SubStatus = ""

	// -- structural / DNS (the local tier can produce all of these) --

	SubStatusSyntaxInvalid  SubStatus = "failed_syntax_check"
	SubStatusNoDNSEntries   SubStatus = "no_dns_entries"
	SubStatusPossibleTypo   SubStatus = "possible_typo"
	SubStatusDisposable     SubStatus = "disposable"
	SubStatusRoleBased      SubStatus = "role_based"
	SubStatusToxic          SubStatus = "toxic"
	SubStatusAliasAddress   SubStatus = "alias_address"
	SubStatusAlternate      SubStatus = "alternate"
	SubStatusGold           SubStatus = "gold"
	SubStatusAIAgentMailbox SubStatus = "ai_agent_mailbox"

	// -- mailbox-level (vendor tier only) --

	SubStatusMailboxNotFound      SubStatus = "mailbox_not_found"
	SubStatusMailboxQuotaExceeded SubStatus = "mailbox_quota_exceeded"
	SubStatusGlobalSuppression    SubStatus = "global_suppression"
	SubStatusPossibleTrap         SubStatus = "possible_trap"
	SubStatusRoleBasedCatchAll    SubStatus = "role_based_catch_all"
	SubStatusRoleBasedAcceptAll   SubStatus = "role_based_accept_all"
	SubStatusDoesNotAcceptMail    SubStatus = "does_not_accept_mail"
	SubStatusUnroutableIPAddress  SubStatus = "unroutable_ip_address"
	SubStatusAcceptAll            SubStatus = "accept_all"
	SubStatusMXForward            SubStatus = "mx_forward"

	// -- transient probe failures (vendor tier only) --

	SubStatusAntispamSystem       SubStatus = "antispam_system"
	SubStatusGreylisted           SubStatus = "greylisted"
	SubStatusServerTemporaryError SubStatus = "mail_server_temporary_error"
	SubStatusServerDidNotRespond  SubStatus = "mail_server_did_not_respond"
	SubStatusForcibleDisconnect   SubStatus = "forcible_disconnect"
	SubStatusTimeoutExceeded      SubStatus = "timeout_exceeded"
	SubStatusFailedSMTPConnection SubStatus = "failed_smtp_connection"
	SubStatusExceptionOccurred    SubStatus = "exception_occurred"

	// -- Moosewave-specific --

	// SubStatusNoMailboxProbe is the local tier's honest ceiling: the
	// domain resolves and accepts mail, but we did not — and will not
	// — probe the mailbox. No vendor reports this because every vendor
	// probes.
	SubStatusNoMailboxProbe SubStatus = "no_mailbox_probe"
	// SubStatusProviderUnavailable marks a result produced when the
	// configured vendor could not be reached at all, so the caller can
	// distinguish "vendor says unknown" from "we never asked".
	SubStatusProviderUnavailable SubStatus = "provider_unavailable"
)

// Valid reports whether s is in the closed canonical sub-status vocabulary.
// Empty is valid because several settled provider outcomes have no finer code.
func (s SubStatus) Valid() bool {
	if s == SubStatusNone {
		return true
	}
	return knownSubStatuses[s]
}

var knownSubStatuses = map[SubStatus]bool{
	SubStatusSyntaxInvalid: true, SubStatusNoDNSEntries: true,
	SubStatusPossibleTypo: true, SubStatusDisposable: true,
	SubStatusRoleBased: true, SubStatusToxic: true,
	SubStatusAliasAddress: true, SubStatusAlternate: true,
	SubStatusGold: true, SubStatusAIAgentMailbox: true,
	SubStatusMailboxNotFound:      true,
	SubStatusMailboxQuotaExceeded: true, SubStatusGlobalSuppression: true,
	SubStatusPossibleTrap: true, SubStatusRoleBasedCatchAll: true,
	SubStatusRoleBasedAcceptAll: true,
	SubStatusDoesNotAcceptMail:  true, SubStatusUnroutableIPAddress: true,
	SubStatusAcceptAll: true, SubStatusMXForward: true,
	SubStatusAntispamSystem: true,
	SubStatusGreylisted:     true, SubStatusServerTemporaryError: true,
	SubStatusServerDidNotRespond: true, SubStatusForcibleDisconnect: true,
	SubStatusTimeoutExceeded: true, SubStatusFailedSMTPConnection: true,
	SubStatusExceptionOccurred: true, SubStatusNoMailboxProbe: true,
	SubStatusProviderUnavailable: true,
}

// Result is the canonical per-address verdict. It is the same shape
// regardless of which driver produced it.
type Result struct {
	Email     string    `json:"email"`
	Status    Status    `json:"status"`
	SubStatus SubStatus `json:"sub_status,omitempty"`

	// Score is the 0-10 engagement/quality score vendors attach to
	// catch-all and unknown addresses — the only usable signal on a
	// domain that accepts everything. nil when the provider did not
	// supply one (always nil for the local tier).
	Score *int `json:"score,omitempty"`

	Domain      string `json:"domain,omitempty"`
	FreeEmail   bool   `json:"free_email"`
	RoleAccount bool   `json:"role_account"`
	Disposable  bool   `json:"disposable"`
	MXFound     bool   `json:"mx_found"`
	MXRecord    string `json:"mx_record,omitempty"`

	// DidYouMean carries a corrected address when the domain looks
	// like a typo of a high-volume provider ("gmial.com").
	DidYouMean string `json:"did_you_mean,omitempty"`

	// FirstName/LastName/Gender/Country/City are the enrichment
	// fields vendors return alongside the verdict. Empty for local.
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
	Gender    string `json:"gender,omitempty"`
	Country   string `json:"country,omitempty"`
	City      string `json:"city,omitempty"`

	// Provider is the driver that produced this verdict.
	Provider string `json:"provider"`
	// Billable reports whether producing this result consumed a paid
	// credit. Drives the credit-accounting surface and lets the chain
	// report its own savings truthfully.
	Billable bool `json:"billable"`
	// Cached reports that this result was served from the tenant's
	// result cache rather than re-verified.
	Cached bool `json:"cached"`

	CheckedAt time.Time `json:"checked_at"`

	// Raw is the untouched provider payload held only in memory at the adapter
	// boundary. It is excluded from JSON and is never cached, persisted, or
	// logged; durable/API surfaces retain only the canonical projection above.
	Raw json.RawMessage `json:"-"`

	// Health is the tenant-derived A/B/C/D/F/U decision appended by HTTP/job
	// read surfaces after verification. Drivers leave it nil because they do
	// not own consent, suppression, or first-party engagement evidence.
	Health *EmailHealth `json:"health,omitempty"`
}

// Sendable is the per-result convenience wrapper over Status.Sendable.
func (r Result) Sendable() bool { return r.Status.Sendable() }

// Verifier is the driver contract. Implementations must be safe for
// concurrent use.
type Verifier interface {
	// Name returns the stable provider identifier.
	Name() string
	// Verify checks a single address.
	Verify(ctx context.Context, email string) (Result, error)
	// VerifyBatch checks many addresses, returning one Result per
	// input in input order. Implementations that have no native batch
	// endpoint may loop.
	VerifyBatch(ctx context.Context, emails []string) ([]Result, error)
	// Credits returns the remaining paid balance, or CreditsUnmetered
	// for providers without one.
	Credits(ctx context.Context) (int, error)
}

// batchDispatchHookVerifier lets a native batch adapter place an exact durable
// receipt immediately before each provider request. It is intentionally
// package-private: callers use Chain, which preserves the cache/local boundary.
type batchDispatchHookVerifier interface {
	verifyBatchWithDispatchHook(
		ctx context.Context,
		emails []string,
		beforeChunk func(context.Context, []string) error,
	) ([]Result, error)
}

// Errors surfaced across drivers so callers can branch without
// string-matching provider messages.
var (
	// ErrNoCredits means the provider rejected the call for an
	// exhausted balance. Callers should stop, not retry.
	ErrNoCredits = errors.New("verification: provider credit balance exhausted")
	// ErrUnauthorized means the stored API key was rejected.
	ErrUnauthorized = errors.New("verification: provider rejected the API key")
	// ErrProviderUnavailable means the provider could not be reached
	// or returned a 5xx. Retryable.
	ErrProviderUnavailable = errors.New("verification: provider unavailable")
	// ErrProviderPartialOutcome means a multi-request provider operation
	// produced at least one response (or indeterminate dispatch) before a
	// terminal auth/quota error. The batch must not be retried automatically:
	// doing so could charge again for the requests that already settled.
	ErrProviderPartialOutcome = errors.New("verification: provider batch outcome is partially settled")
	// ErrProviderAccountRejected is a provider-wide, explicitly non-billable
	// rejection whose response conflates credential and balance state. Callers
	// must prompt the operator to inspect both without claiming which one failed.
	ErrProviderAccountRejected = errors.New("verification: provider rejected the configured account")
	// ErrCacheUnavailable means Moosewave could not prove whether an address has
	// already consumed a provider credit, or could not durably retain a newly
	// paid result. Callers must not silently cross or repeat the metered boundary.
	ErrCacheUnavailable = errors.New("verification: result cache unavailable")
	// ErrUsagePersistence means verification completed but the tenant-scoped
	// usage ledger could not durably confirm its accounting outcome. The exact
	// request must remain replay-fenced because retrying an uncertain increment
	// can double-count while dropping it can under-count provider spend.
	ErrUsagePersistence = errors.New("verification: usage accounting outcome unavailable")
	// ErrNotConfigured means the tenant has no vendor configured.
	ErrNotConfigured = errors.New("verification: no verification provider configured")
	// ErrBatchTooLarge means the caller exceeded MaxBatch.
	ErrBatchTooLarge = errors.New("verification: batch exceeds maximum size")
)

// isExplicitUnbilledProviderRejection identifies provider-wide responses that
// prove no address work settled. It deliberately excludes a joined partial
// marker, which means an earlier chunk may already have consumed credits.
func isExplicitUnbilledProviderRejection(err error) bool {
	if errors.Is(err, ErrProviderPartialOutcome) {
		return false
	}
	return errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized) ||
		errors.Is(err, ErrProviderAccountRejected) || errors.Is(err, ErrNotConfigured)
}

// MaxBatch caps package-internal batch work. Durable jobs use bounded chunks
// up to this size and the non-billable health resolver exposes the same limit.
// The paid synchronous HTTP route has the much smaller
// MaxSynchronousBatch ceiling below.
const MaxBatch = 1000

const (
	// MaxSynchronousBatch keeps one billable HTTP request inside a single
	// provider latency wave: one eight-wide Kickbox wave or one bounded
	// ZeroBounce real-time batch. Larger work belongs on the durable job route,
	// where leases and request-start receipts survive client disconnects.
	MaxSynchronousBatch = 8
	// SynchronousRequestTimeout bounds the complete handler path, including
	// cache/local checks, provider dispatch, health enrichment, and response
	// construction. Production's finite HTTP write window leaves a separate
	// margin for middleware to persist the exact idempotent response.
	SynchronousRequestTimeout = 80 * time.Second
)
