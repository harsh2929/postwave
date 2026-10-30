// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Provider payloads are capped as a whole, but every projected string needs a
// substantially smaller contract before it can reach JSON or durable storage.
// Bounds are bytes so they match PostgreSQL octet_length constraints.
const (
	maxPersistedVerificationEmailBytes = 320
	maxProviderIdentityEmailBytes      = 254
	maxVerificationDomainBytes         = 253
	maxVerificationMXRecordBytes       = 253
	maxVerificationSuggestionBytes     = 254
	maxVerificationPersonNameBytes     = 256
	maxVerificationGenderBytes         = 64
	maxVerificationCountryBytes        = 128
	maxVerificationCityBytes           = 256
)

func invalidProviderResultField(field string) error {
	return fmt.Errorf("verification: provider result has an invalid %s field: %w",
		field, ErrProviderPartialOutcome)
}

func unsafeProviderResultText(value string) bool {
	if !utf8.ValidString(value) {
		return true
	}
	for _, r := range value {
		// Cf covers bidi overrides and zero-width format characters. Private-use
		// and separator controls are also inappropriate in provider-originated
		// fields rendered in operator UI or persisted for later display.
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) ||
			unicode.Is(unicode.Co, r) || unicode.Is(unicode.Cs, r) ||
			unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) {
			return true
		}
	}
	return false
}

func validateProviderResultText(field, value string, maxBytes int) error {
	if len(value) > maxBytes || unsafeProviderResultText(value) {
		return invalidProviderResultField(field)
	}
	return nil
}

func canonicalProviderSuggestion(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if err := validateProviderResultText("did_you_mean", raw, maxVerificationSuggestionBytes); err != nil {
		return "", err
	}
	if strings.TrimSpace(raw) != raw {
		return "", invalidProviderResultField("did_you_mean")
	}
	normalized := NormalizeEmail(raw)
	if _, _, ok := splitAddress(normalized); !ok {
		return "", invalidProviderResultField("did_you_mean")
	}
	return normalized, nil
}

// validateProviderProjection checks a post-dispatch adapter projection before
// it is returned. Identity fields are matched to the trusted request; optional
// enrichment is rejected rather than truncated when malformed.
func validateProviderProjection(result Result, requested string) error {
	requested = NormalizeEmail(requested)
	_, requestedDomain, ok := splitAddress(requested)
	if !ok && result.Status == StatusInvalid && result.SubStatus == SubStatusPossibleTypo {
		_, requestedDomain, ok = splitProviderTypoAddress(requested)
	}
	if !ok {
		return invalidProviderResultField("requested_email")
	}
	if err := validateProviderResultText("email", result.Email, maxProviderIdentityEmailBytes); err != nil {
		return err
	}
	if strings.TrimSpace(result.Email) != result.Email || NormalizeEmail(result.Email) != requested {
		return invalidProviderResultField("email")
	}
	if !result.Status.Valid() {
		return invalidProviderResultField("status")
	}
	if !result.SubStatus.Valid() {
		return invalidProviderResultField("sub_status")
	}
	if result.Score != nil && (*result.Score < 0 || *result.Score > 10) {
		return invalidProviderResultField("score")
	}
	if err := validateProviderSemanticProjection(result); err != nil {
		return err
	}
	if result.Domain != "" {
		if err := validateProviderResultText("domain", result.Domain, maxVerificationDomainBytes); err != nil {
			return err
		}
		if strings.TrimSpace(result.Domain) != result.Domain ||
			!strings.EqualFold(result.Domain, requestedDomain) {
			return invalidProviderResultField("domain")
		}
	}
	if _, err := canonicalProviderSuggestion(result.DidYouMean); err != nil {
		return err
	}
	if err := validateProviderOptionalProjection(result); err != nil {
		return err
	}
	switch result.Provider {
	case ProviderZeroBounce, ProviderKickbox:
		return nil
	default:
		return invalidProviderResultField("provider")
	}
}

func splitProviderTypoAddress(email string) (string, string, bool) {
	if email == "" || len(email) > maxProviderIdentityEmailBytes || unsafeProviderResultText(email) {
		return "", "", false
	}
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || at == len(email)-1 || at > 64 {
		return "", "", false
	}
	local, domain := email[:at], email[at+1:]
	if _, canonicalDomain, ok := splitAddress("x@" + domain); !ok || canonicalDomain != domain {
		return "", "", false
	}
	return local, domain, true
}

// validateProviderSemanticProjection rejects combinations whose individual
// fields are valid but whose joint meaning is not. Provider adapters must never
// resolve an internally contradictory paid response by choosing whichever
// field happens to be checked first: that can manufacture a sendable Valid or
// CatchAll verdict from terminal evidence. The safe outcome after dispatch is
// an indeterminate provider response.
func validateProviderSemanticProjection(result Result) error {
	compatible := false
	switch result.Status {
	case StatusValid:
		compatible = !result.Disposable && oneOfSubStatus(result.SubStatus,
			SubStatusNone, SubStatusRoleBased, SubStatusAliasAddress,
			SubStatusAlternate, SubStatusGold, SubStatusAIAgentMailbox)
	case StatusCatchAll:
		compatible = !result.Disposable && oneOfSubStatus(result.SubStatus,
			SubStatusNone, SubStatusAcceptAll, SubStatusRoleBased,
			SubStatusRoleBasedCatchAll, SubStatusRoleBasedAcceptAll,
			SubStatusAIAgentMailbox)
	case StatusUnknown:
		// Unknown remains send-eligible under the platform's coverage policy, so
		// it may carry only genuinely indeterminate/advisory reasons. Definitive
		// invalid, terminal, disposable, or catch-all provider evidence must not
		// be hidden behind it. The local verifier is the narrow exception: its
		// bundled disposable-domain corpus is intentionally advisory rather than
		// proof that a mailbox will not deliver.
		localAdvisoryDisposable := result.Provider == ProviderLocal &&
			result.Disposable && result.SubStatus == SubStatusDisposable
		compatible = localAdvisoryDisposable || (!result.Disposable && oneOfSubStatus(result.SubStatus,
			SubStatusNone, SubStatusRoleBased, SubStatusAliasAddress,
			SubStatusAntispamSystem, SubStatusGreylisted,
			SubStatusServerTemporaryError, SubStatusServerDidNotRespond,
			SubStatusForcibleDisconnect, SubStatusTimeoutExceeded,
			SubStatusFailedSMTPConnection, SubStatusExceptionOccurred,
			SubStatusMailboxQuotaExceeded, SubStatusNoMailboxProbe,
			SubStatusProviderUnavailable))
	case StatusInvalid:
		// Invalid is already a hard stop. Accept-all evidence is the one material
		// contradiction because it expressly says per-mailbox invalidity is not
		// knowable.
		compatible = !oneOfSubStatus(result.SubStatus,
			SubStatusAcceptAll, SubStatusRoleBasedCatchAll,
			SubStatusRoleBasedAcceptAll, SubStatusAlternate, SubStatusGold,
			SubStatusAIAgentMailbox, SubStatusAliasAddress)
	case StatusSpamtrap, StatusAbuse:
		compatible = !oneOfSubStatus(result.SubStatus,
			SubStatusAcceptAll, SubStatusRoleBasedCatchAll,
			SubStatusRoleBasedAcceptAll, SubStatusAlternate, SubStatusGold,
			SubStatusAIAgentMailbox, SubStatusAliasAddress)
	case StatusDoNotMail:
		compatible = oneOfSubStatus(result.SubStatus,
			SubStatusNone, SubStatusDisposable, SubStatusToxic,
			SubStatusRoleBased, SubStatusRoleBasedCatchAll,
			SubStatusGlobalSuppression, SubStatusPossibleTrap,
			SubStatusMXForward)
	}
	if !compatible {
		return invalidProviderResultField("status_semantics")
	}
	return nil
}

func oneOfSubStatus(value SubStatus, candidates ...SubStatus) bool {
	for _, candidate := range candidates {
		if value == candidate {
			return true
		}
	}
	return false
}

func validateProviderOptionalProjection(result Result) error {
	for _, field := range []struct {
		name  string
		value string
		max   int
	}{
		{name: "mx_record", value: result.MXRecord, max: maxVerificationMXRecordBytes},
		{name: "first_name", value: result.FirstName, max: maxVerificationPersonNameBytes},
		{name: "last_name", value: result.LastName, max: maxVerificationPersonNameBytes},
		{name: "gender", value: result.Gender, max: maxVerificationGenderBytes},
		{name: "country", value: result.Country, max: maxVerificationCountryBytes},
		{name: "city", value: result.City, max: maxVerificationCityBytes},
	} {
		if err := validateProviderResultText(field.name, field.value, field.max); err != nil {
			return err
		}
		if field.value != "" && strings.TrimSpace(field.value) != field.value {
			return invalidProviderResultField(field.name)
		}
	}
	return nil
}

// validatePersistableResult is the last application-level defense before a
// canonical result reaches cache/job storage. It intentionally permits an
// invalid input address (the verifier must be able to persist syntax failures),
// but requires the storage key to already be bounded, control-safe, and in the
// exact normalized form.
func validatePersistableResult(result Result) error {
	if result.Email == "" || len(result.Email) > maxPersistedVerificationEmailBytes ||
		unsafeProviderResultText(result.Email) || NormalizeEmail(result.Email) != result.Email {
		return invalidProviderResultField("email")
	}
	if !result.Status.Valid() {
		return invalidProviderResultField("status")
	}
	if !result.SubStatus.Valid() {
		return invalidProviderResultField("sub_status")
	}
	if result.Score != nil && (*result.Score < 0 || *result.Score > 10) {
		return invalidProviderResultField("score")
	}
	if err := validateProviderSemanticProjection(result); err != nil {
		return err
	}
	if result.Domain != "" {
		if err := validateProviderResultText("domain", result.Domain, maxVerificationDomainBytes); err != nil {
			return err
		}
		if strings.ToLower(strings.TrimSpace(result.Domain)) != result.Domain {
			return invalidProviderResultField("domain")
		}
		if _, domain, ok := splitAddress("x@" + result.Domain); !ok || domain != result.Domain {
			return invalidProviderResultField("domain")
		}
	}
	if result.DidYouMean != "" {
		suggestion, err := canonicalProviderSuggestion(result.DidYouMean)
		if err != nil || suggestion != result.DidYouMean {
			return invalidProviderResultField("did_you_mean")
		}
	}
	if err := validateProviderOptionalProjection(result); err != nil {
		return err
	}
	switch result.Provider {
	case ProviderLocal:
		// DNS/syntax checks can disprove an address or surface advisory
		// uncertainty, but they can never prove a mailbox valid or catch-all.
		if result.Status == StatusValid || result.Status == StatusCatchAll ||
			result.Status == StatusSpamtrap {
			return invalidProviderResultField("provider_status_semantics")
		}
		return nil
	case ProviderZeroBounce, ProviderKickbox:
		return nil
	default:
		return invalidProviderResultField("provider")
	}
}
