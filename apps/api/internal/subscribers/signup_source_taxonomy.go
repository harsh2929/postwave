package subscribers

import "strings"

// signup_source_taxonomy.go — pure helpers for the signup_source
// vocabulary. Kept separate from signup_source.go (which carries the
// DB read/write helpers) so this file is dependency-free and trivially
// table-testable.

// NormalizeSignupSource lower-cases and trims s, then returns it if it
// matches a known CHECK-vocabulary value. Unknown / empty values fall
// back to SignupSourceUnknown so callers never have to defensively
// substitute themselves.
func NormalizeSignupSource(s string) string {
	v := strings.ToLower(strings.TrimSpace(s))
	if v == "" {
		return SignupSourceUnknown
	}
	switch v {
	case SignupSourceEmbeddedForm,
		SignupSourceHostedPage,
		SignupSourceImport,
		SignupSourceAPI,
		SignupSourceIntegration,
		SignupSourcePopup,
		SignupSourceLandingPage,
		SignupSourceAdmin,
		SignupSourceUnknown:
		return v
	}
	return SignupSourceUnknown
}

// ValidSignupSource reports whether s is exactly one of the CHECK-
// vocabulary values. Empty / mixed-case / unknown strings return false.
// Callers wanting fuzzy acceptance should NormalizeSignupSource first.
func ValidSignupSource(s string) bool {
	switch s {
	case SignupSourceEmbeddedForm,
		SignupSourceHostedPage,
		SignupSourceImport,
		SignupSourceAPI,
		SignupSourceIntegration,
		SignupSourcePopup,
		SignupSourceLandingPage,
		SignupSourceAdmin,
		SignupSourceUnknown:
		return true
	}
	return false
}

// SignupSourceFromConsent maps a consent_source value into the closest
// signup_source bucket. Used by resolveSignupSource as the fallback
// inference path when the caller hasn't supplied an explicit value.
func SignupSourceFromConsent(consent string) string {
	switch strings.ToLower(strings.TrimSpace(consent)) {
	case ConsentImport:
		return SignupSourceImport
	case ConsentAPI:
		return SignupSourceAPI
	case ConsentDoubleOptIn, ConsentSingleOptIn:
		return SignupSourceEmbeddedForm
	}
	return SignupSourceUnknown
}
