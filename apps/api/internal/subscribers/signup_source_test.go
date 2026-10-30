package subscribers

import "testing"

func TestValidSignupSource(t *testing.T) {
	for _, v := range []string{
		SignupSourceEmbeddedForm,
		SignupSourceHostedPage,
		SignupSourceImport,
		SignupSourceAPI,
		SignupSourceIntegration,
		SignupSourceUnknown,
	} {
		if !ValidSignupSource(v) {
			t.Errorf("ValidSignupSource(%q) = false; want true", v)
		}
	}
	for _, v := range []string{"", "spam", "EMBEDDED_FORM", "form"} {
		if ValidSignupSource(v) {
			t.Errorf("ValidSignupSource(%q) = true; want false", v)
		}
	}
}

func TestNormalizeSignupSource(t *testing.T) {
	cases := map[string]string{
		"":                                SignupSourceUnknown,
		"   ":                             SignupSourceUnknown,
		"EMBEDDED_FORM":                   SignupSourceEmbeddedForm,
		"  hosted_page  ":                 SignupSourceHostedPage,
		"api":                             SignupSourceAPI,
		"integration":                     SignupSourceIntegration,
		"import":                          SignupSourceImport,
		"unknown":                         SignupSourceUnknown,
		"this is not a real value at all": SignupSourceUnknown,
	}
	for in, want := range cases {
		if got := NormalizeSignupSource(in); got != want {
			t.Errorf("NormalizeSignupSource(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestSignupSourceFromConsent(t *testing.T) {
	cases := map[string]string{
		ConsentImport:      SignupSourceImport,
		ConsentAPI:         SignupSourceAPI,
		ConsentDoubleOptIn: SignupSourceEmbeddedForm,
		ConsentSingleOptIn: SignupSourceEmbeddedForm,
		ConsentUnknown:     SignupSourceUnknown,
		"":                 SignupSourceUnknown,
		"weird":            SignupSourceUnknown,
		// Case-insensitive.
		"API": SignupSourceAPI,
	}
	for in, want := range cases {
		if got := SignupSourceFromConsent(in); got != want {
			t.Errorf("SignupSourceFromConsent(%q) = %q; want %q", in, got, want)
		}
	}
}

func TestResolveSignupSource(t *testing.T) {
	// Explicit valid wins.
	if got := resolveSignupSource(SignupSourceHostedPage, ConsentAPI); got != SignupSourceHostedPage {
		t.Errorf("explicit hosted_page over consent api = %q; want hosted_page", got)
	}
	// Empty explicit falls through to consent inference.
	if got := resolveSignupSource("", ConsentImport); got != SignupSourceImport {
		t.Errorf("empty explicit + import consent = %q; want import", got)
	}
	// Invalid explicit falls through.
	if got := resolveSignupSource("garbage", ConsentDoubleOptIn); got != SignupSourceEmbeddedForm {
		t.Errorf("garbage explicit + double_optin consent = %q; want embedded_form", got)
	}
	// Both empty → unknown.
	if got := resolveSignupSource("", ""); got != SignupSourceUnknown {
		t.Errorf("both empty = %q; want unknown", got)
	}
	// "unknown" explicit + valid consent → consent inference is preferred
	// because 'unknown' is the placeholder value the resolver treats as
	// "not set yet" (so we can upgrade later).
	if got := resolveSignupSource(SignupSourceUnknown, ConsentSingleOptIn); got != SignupSourceEmbeddedForm {
		t.Errorf("unknown explicit + single_optin consent = %q; want embedded_form", got)
	}
}
