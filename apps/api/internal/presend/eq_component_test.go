// SPDX-License-Identifier: AGPL-3.0-only

package presend

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/eqscore"
)

func senderAuth(state eqscore.SenderAuthState) eqscore.SenderAuthResolver {
	return eqscore.SenderAuthResolverFunc(func(context.Context, string, string) (eqscore.SenderAuthState, error) {
		return state, nil
	})
}

func componentNamed(t *testing.T, response Response, name string) Component {
	t.Helper()
	for _, component := range response.Components {
		if component.Name == name {
			return component
		}
	}
	t.Fatalf("response has no %s component: %+v", name, response.Components)
	return Component{}
}

const genericCriticalEQ = "Pre-send EQ Score found a blocking content, sender-authentication, or reputation issue."

// The verdict read "Critical · 59 / 100 — Pre-send EQ Score found a blocking
// content, sender-authentication, or reputation issue." for a sender whose
// domain simply was not verified. The EQ score knew exactly that; the verdict
// threw it away.
func TestHandleCriticalEQNamesTheBlockingReason(t *testing.T) {
	d := completeDeps(&Deps{SenderAuth: senderAuth(eqscore.SenderAuthState{
		Domain: "example.test", DKIMVerified: true, SPFVerified: true, DMARCAligned: true,
	})})

	_, response := executeHandler(t, d, goodInput(), "tenant-1", "")

	eq := componentNamed(t, response, "eq_score")
	if eq.Status != "critical" {
		t.Fatalf("EQ = %+v, want critical for an unverified From domain", eq)
	}
	if !strings.Contains(eq.Message, "The From domain (example.test) is not verified for this workspace") {
		t.Fatalf("EQ message %q does not name the unverified domain", eq.Message)
	}
	if strings.Contains(eq.Message, genericCriticalEQ) {
		t.Fatalf("EQ message is still the generic sentence: %q", eq.Message)
	}
	if len(eq.Reasons) == 0 || eq.Reasons[0].Code != "domain_not_verified" || eq.Reasons[0].Severity != "fail" {
		t.Fatalf("EQ reasons = %+v, want domain_not_verified first", eq.Reasons)
	}
	if !strings.Contains(response.Summary, "is not verified for this workspace") {
		t.Fatalf("summary %q does not carry the blocking reason", response.Summary)
	}
}

// A warning names the thing to fix, too.
func TestHandleWarnEQNamesTheMissingAuthentication(t *testing.T) {
	d := completeDeps(&Deps{SenderAuth: senderAuth(eqscore.SenderAuthState{
		Domain: "example.test", DomainVerified: true, SPFVerified: true, DMARCAligned: true,
	})})

	_, response := executeHandler(t, d, goodInput(), "tenant-1", "")

	eq := componentNamed(t, response, "eq_score")
	if eq.Status != "warn" {
		t.Fatalf("EQ = %+v, want warn for missing DKIM", eq)
	}
	if !strings.Contains(eq.Message, "DKIM is not aligned for example.test") {
		t.Fatalf("EQ message %q does not name the missing DKIM alignment", eq.Message)
	}
	found := false
	for _, reason := range eq.Reasons {
		found = found || reason.Code == "dkim_missing"
	}
	if !found {
		t.Fatalf("EQ reasons = %+v, want dkim_missing", eq.Reasons)
	}
}

// A clean score carries no reasons and no message.
func TestHandleCleanEQCarriesNoReasons(t *testing.T) {
	_, response := executeHandler(t, completeDeps(&Deps{}), goodInput(), "tenant-1", "")
	eq := componentNamed(t, response, "eq_score")
	if eq.Status != "ok" || eq.Message != "" || len(eq.Reasons) != 0 {
		t.Fatalf("clean EQ = %+v, want ok with no message or reasons", eq)
	}
}

// However many causes a draft trips, the message stays one readable line well
// inside the clients' 4,000-character decode bound; the full list is in
// Reasons.
func TestEQMessageNamesTheWorstCausesAndCountsTheRest(t *testing.T) {
	reasons := make([]eqscore.Reason, 0, 8)
	for i := 0; i < 8; i++ {
		reasons = append(reasons, eqscore.Reason{
			Code: "subject_spammy_phrase", Severity: "warning",
			Message: strings.Repeat("A very long explanation of one more thing to fix. ", 20),
		})
	}
	component := eqScoreComponent(eqscore.Result{Score: 50, Reasons: reasons})

	if component.Status != "warn" {
		t.Fatalf("status = %q, want warn", component.Status)
	}
	if len(component.Message) > maxComponentMessageBytes {
		t.Fatalf("message is %d bytes, want at most %d", len(component.Message), maxComponentMessageBytes)
	}
	if len(component.Reasons) != 8 {
		t.Fatalf("reasons = %d, want all 8 carried for clients to list", len(component.Reasons))
	}

	short := eqScoreComponent(eqscore.Result{Score: 50, Reasons: []eqscore.Reason{
		{Code: "a", Severity: "warning", Message: "First."},
		{Code: "b", Severity: "warning", Message: "Second."},
		{Code: "c", Severity: "warning", Message: "Third."},
		{Code: "d", Severity: "warning", Message: "Fourth."},
		{Code: "e", Severity: "info", Message: "Just so you know."},
	}})
	if short.Message != "First. Second. Third. (+1 more)" {
		t.Fatalf("message = %q, want the first three warnings and a count of the rest", short.Message)
	}
	if len(short.Reasons) != 4 {
		t.Fatalf("reasons = %+v, want the four warnings without the informational note", short.Reasons)
	}
}

// A score dragged under 40 by warnings alone is critical, and its message names
// those warnings rather than claiming a blocking failure it cannot name.
func TestCriticalEQWithoutAFailingReasonNamesItsWarnings(t *testing.T) {
	component := eqScoreComponent(eqscore.Result{Score: 35, Reasons: []eqscore.Reason{
		{Code: "image_heavy", Severity: "warning", Message: "The email is mostly images."},
	}})
	if component.Status != "critical" || component.Message != "The email is mostly images." {
		t.Fatalf("component = %+v, want critical naming its warning", component)
	}
}

// The summary is read by people; it must not print the wire keys of the checks.
func TestVerdictSummaryUsesTheChecksHumanNames(t *testing.T) {
	_, summary, _ := computeVerdict([]Component{
		{Name: "eq_score", Status: "critical", Message: "The From domain is not verified."},
		{Name: "voice_drift", Status: "error"},
		{Name: "placement", Status: "warn", Message: "Predicted Primary placement is below 55%."},
	})
	for _, label := range []string{"Content quality: The From domain is not verified.", "Voice alignment", "Primary placement:"} {
		if !strings.Contains(summary, label) {
			t.Fatalf("summary %q does not name %q", summary, label)
		}
	}
	// With the human names and the messages removed, no wire key remains.
	rest := summary
	for _, known := range []string{"Primary placement: Predicted Primary placement is below 55%.", "Content quality", "Voice alignment"} {
		rest = strings.ReplaceAll(rest, known, "")
	}
	for _, key := range []string{"eq_score", "voice_drift", "placement"} {
		if strings.Contains(rest, key) {
			t.Fatalf("summary %q prints the wire key %q", summary, key)
		}
	}
}
