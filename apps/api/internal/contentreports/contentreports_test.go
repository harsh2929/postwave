// SPDX-License-Identifier: AGPL-3.0-only

package contentreports

import (
	"errors"
	"strings"
	"testing"
)

func validNotice() PublicNotice {
	return PublicNotice{
		SubjectKind:       "archive_comment",
		SubjectURL:        "https://archive.example.com/post/hello#comment-3",
		ReasonCategory:    "harassment_or_hate",
		Explanation:       "This comment names my home address and tells people to go there.",
		NotifierName:      "A Person",
		NotifierEmail:     "person@example.com",
		GoodFaithDeclared: true,
	}
}

func TestAValidNoticePasses(t *testing.T) {
	n := validNotice()
	if err := ValidatePublicNotice(&n); err != nil {
		t.Fatalf("ValidatePublicNotice: %v", err)
	}
}

func TestTheArticle16ElementsAreEachRequired(t *testing.T) {
	// Art. 16(2) lists what makes a notice sufficiently precise and adequately
	// substantiated. Each element is tested separately because dropping any one
	// of them is what turns a notice into something we can argue we never
	// really received — and the Art. 6 liability exemption turns on exactly
	// that argument going the other way.
	cases := []struct {
		name    string
		mutate  func(*PublicNotice)
		wantErr error
	}{
		{
			"16(2)(a): an explanation short enough to be no explanation",
			func(n *PublicNotice) { n.Explanation = "bad" },
			ErrExplanationTooShort,
		},
		{
			"16(2)(a): an explanation longer than the column",
			func(n *PublicNotice) { n.Explanation = strings.Repeat("x", maxExplanationRunes+1) },
			ErrExplanationTooShort,
		},
		{
			"16(2)(b): no location",
			func(n *PublicNotice) { n.SubjectURL = "" },
			ErrInvalidSubjectURL,
		},
		{
			"16(2)(b): a relative path is not a location",
			func(n *PublicNotice) { n.SubjectURL = "/post/hello" },
			ErrInvalidSubjectURL,
		},
		{
			"16(2)(b): a javascript: URL is not a location and must not reach an operator's browser",
			func(n *PublicNotice) { n.SubjectURL = "javascript:alert(1)" },
			ErrInvalidSubjectURL,
		},
		{
			// The case the first javascript: test does NOT cover. That one is
			// rejected for having no host, so it passes even with the scheme
			// check removed — mutation testing found the scheme check
			// untested. This shape parses WITH a host and is a real
			// operator-clicks-the-link bypass.
			"16(2)(b): a javascript: URL with an authority is still not a location",
			func(n *PublicNotice) { n.SubjectURL = "javascript://example.com/%0aalert(1)" },
			ErrInvalidSubjectURL,
		},
		{
			"16(2)(b): a non-web scheme with a valid host is still not a web location",
			func(n *PublicNotice) { n.SubjectURL = "ftp://files.example.com/thing" },
			ErrInvalidSubjectURL,
		},
		{
			"16(2)(c): no notifier email",
			func(n *PublicNotice) { n.NotifierEmail = "" },
			ErrNotifierRequired,
		},
		{
			"16(2)(c): an unparseable notifier email",
			func(n *PublicNotice) { n.NotifierEmail = "not-an-address" },
			ErrNotifierRequired,
		},
		{
			"16(2)(d): no good-faith declaration",
			func(n *PublicNotice) { n.GoodFaithDeclared = false },
			ErrGoodFaithRequired,
		},
		{
			"an unknown ground",
			func(n *PublicNotice) { n.ReasonCategory = "vibes" },
			ErrInvalidCategory,
		},
		{
			"an unknown subject kind",
			func(n *PublicNotice) { n.SubjectKind = "spreadsheet" },
			ErrInvalidSubjectKind,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			n := validNotice()
			tc.mutate(&n)
			err := ValidatePublicNotice(&n)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestAChildSafetyReportMayBeAnonymous(t *testing.T) {
	// Art. 16(2)(c) requires the notifier's name and email EXCEPT for notices
	// concerning offences under Articles 3-7 of Directive 2011/93/EU. A
	// validation rule that demanded identity here would turn the reporting
	// mechanism into a reason not to report, which is the opposite of what the
	// exception exists for.
	n := validNotice()
	n.ReasonCategory = "csam_or_child_safety"
	n.NotifierName = ""
	n.NotifierEmail = ""
	if err := ValidatePublicNotice(&n); err != nil {
		t.Fatalf("an anonymous child-safety report must be accepted, got %v", err)
	}
}

func TestIdentityIsStillRequiredForEveryOtherGround(t *testing.T) {
	// The mirror of the test above. If the exception widened to every category
	// the first test would still pass, so this is what pins it shut.
	for category := range reasonCategories {
		if category == "csam_or_child_safety" {
			continue
		}
		n := validNotice()
		n.ReasonCategory = category
		n.NotifierEmail = ""
		if err := ValidatePublicNotice(&n); !errors.Is(err, ErrNotifierRequired) {
			t.Fatalf("category %q with no email: err = %v, want ErrNotifierRequired", category, err)
		}
	}
}

func TestValidationTrimsBeforeItJudges(t *testing.T) {
	// A form posts padded values. An explanation of twenty spaces is not
	// twenty characters of substantiation.
	n := validNotice()
	n.Explanation = "   " + strings.Repeat(" ", 30) + "   "
	if err := ValidatePublicNotice(&n); !errors.Is(err, ErrExplanationTooShort) {
		t.Fatalf("whitespace-only explanation: err = %v, want ErrExplanationTooShort", err)
	}

	n = validNotice()
	n.NotifierEmail = "  person@example.com  "
	if err := ValidatePublicNotice(&n); err != nil {
		t.Fatalf("a padded but valid email must be accepted: %v", err)
	}
	if n.NotifierEmail != "person@example.com" {
		t.Fatalf("email not normalised: %q", n.NotifierEmail)
	}
}

func TestEveryReferenceIsWellFormedAndDistinct(t *testing.T) {
	// The reference is the notifier's only handle on their own report, and the
	// database CHECK is '^PWR-[0-9A-HJ-NP-Z]{10}$'. A generator that emitted an
	// I, L, O or U would fail the insert at runtime rather than here.
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		ref, err := newReference()
		if err != nil {
			t.Fatalf("newReference: %v", err)
		}
		if !strings.HasPrefix(ref, "PWR-") || len(ref) != 14 {
			t.Fatalf("malformed reference %q", ref)
		}
		for _, c := range ref[4:] {
			if !strings.ContainsRune(referenceAlphabet, c) {
				t.Fatalf("reference %q contains %q, which is outside the CHECK constraint's alphabet", ref, c)
			}
		}
		if seen[ref] {
			t.Fatalf("duplicate reference %q after %d draws", ref, i)
		}
		seen[ref] = true
	}
}

func TestTheReferenceAlphabetOmitsTheAmbiguousLetters(t *testing.T) {
	// A receipt gets read over the phone and typed back in. 0/O and 1/I/L are
	// where that goes wrong; U is dropped so a random draw cannot spell an
	// obscenity. This is a contract with the database CHECK, not a preference.
	for _, c := range "ILOU" {
		if strings.ContainsRune(referenceAlphabet, c) {
			t.Fatalf("alphabet contains %q", c)
		}
	}
	if len(referenceAlphabet) != 32 {
		t.Fatalf("alphabet has %d symbols, want 32", len(referenceAlphabet))
	}
}

func TestAnInAppReportRefusesAPublicNoticeOrigin(t *testing.T) {
	// The definer function in migration 2041 is the only path allowed to write
	// origin='public_notice', and the RLS insert policy enforces the same
	// thing. This check makes the refusal legible at the call site rather than
	// arriving as a constraint violation from Postgres.
	r := &Repo{}
	_, err := r.RecordInAppReport(t.Context(), "tenant", InAppReport{
		Origin:         OriginPublicNotice,
		SubjectKind:    "ai_output",
		ReasonCategory: "ai_output_harmful",
		Explanation:    "The assistant produced a slur in the generated subject line.",
	})
	if err == nil || !strings.Contains(err.Error(), "in-app origin") {
		t.Fatalf("err = %v, want a refusal naming the allowed origins", err)
	}
}

func TestDecisionActionsMapToATerminalStatus(t *testing.T) {
	// The report status is derived from the action rather than supplied, so a
	// caller cannot record "content_removed" alongside a queue state of
	// "no_action". Every action must therefore have a mapping — a missing one
	// would be a silently unrecordable decision.
	for action, status := range decisionActions {
		if status != "action_taken" && status != "no_action" {
			t.Fatalf("action %q maps to %q, which is not a terminal status", action, status)
		}
	}
	if decisionActions["no_action"] != "no_action" {
		t.Fatal("no_action must not mark the report as acted upon")
	}
	for _, acted := range []string{
		"content_removed", "content_disabled", "visibility_restricted",
		"account_suspended", "account_terminated",
	} {
		if decisionActions[acted] != "action_taken" {
			t.Fatalf("%q must mark the report as acted upon", acted)
		}
	}
}
