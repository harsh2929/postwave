package subscribers

import (
	"strings"
	"testing"
	"time"
)

// Creating an enabled subscriber requires EIGHT consent facts. normalizeCreate
// checked them in source order and returned on the first failure, so a client
// holding none of them learned about exactly one per attempt: eight rejected
// requests to discover what the ninth needed. Measured against the running
// server, not inferred -- the walk took 8 sequential 400s.
//
// A missing-fields list is not a preference. Every one of those trips writes a
// rejected-write audit row and burns a rate-limit token, and on a phone each is
// a separate round trip over a mobile link. The information was all available
// on the first call.
//
// The contract kept: when exactly ONE requirement fails, the message is
// BYTE-IDENTICAL to what it always was. Only the multi-failure case changes,
// and that case previously could not be observed at all.

func enabledMissingEverything() *CreateInput {
	ts := time.Now().UTC().Add(-time.Hour)
	return &CreateInput{
		Email:            "batch@example.com",
		Status:           StatusEnabled,
		ConsentTimestamp: &ts,
		ConsentSource:    ConsentDoubleOptIn,
		// channel, legal basis, evidence, reason, country, policy version: absent
	}
}

func TestAllMissingConsentFieldsAreReportedTogether(t *testing.T) {
	err := normalizeCreate(enabledMissingEverything())
	if err == nil {
		t.Fatal("a body missing six consent requirements must not validate")
	}
	msg := err.Error()
	for _, want := range []string{
		"consent_channel", "consent_legal_basis", "consent_evidence",
		"consent_reason", "country", "consent_policy_version",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("the caller still cannot see %q in one reply: %s", want, msg)
		}
	}
}

func TestOneMissingFieldKeepsItsExactHistoricalMessage(t *testing.T) {
	// Everything present except the policy version. This is the wording clients
	// and docs already have; batching must not disturb it.
	ts := time.Now().UTC().Add(-time.Hour)
	in := &CreateInput{
		Email: "single@example.com", Status: StatusEnabled, ConsentTimestamp: &ts,
		ConsentSource: ConsentDoubleOptIn, ConsentChannel: "email",
		ConsentLegalBasis: "consent", ConsentEvidence: "e", ConsentReason: "r",
		Country: "US",
	}
	err := normalizeCreate(in)
	if err == nil {
		t.Fatal("expected the policy-version requirement to fail")
	}
	const historical = "consent_policy_version is required and must be 100 characters or fewer"
	if err.Error() != historical {
		t.Fatalf("single-failure wording changed.\n got: %q\nwant: %q", err.Error(), historical)
	}
}

func TestAValidEnabledBodyStillPasses(t *testing.T) {
	// The guard must not become a new way to fail.
	ts := time.Now().UTC().Add(-time.Hour)
	in := &CreateInput{
		Email: "ok@example.com", Status: StatusEnabled, ConsentTimestamp: &ts,
		ConsentSource: ConsentDoubleOptIn, ConsentChannel: "email",
		ConsentLegalBasis: "consent", ConsentEvidence: "e", ConsentReason: "r",
		Country: "US", ConsentPolicyVersion: "v1",
	}
	if err := normalizeCreate(in); err != nil {
		t.Fatalf("a complete consent body must validate: %v", err)
	}
}

func TestPreconditionsStillShortCircuit(t *testing.T) {
	// Attaching consent to a non-enabled subscriber is not a missing-field
	// problem, it is a category error: there is no checklist to enumerate. It
	// must stay a single, unbatched message.
	ts := time.Now().UTC().Add(-time.Hour)
	in := &CreateInput{Email: "x@example.com", Status: StatusUnconfirmed, ConsentTimestamp: &ts}
	err := normalizeCreate(in)
	if err == nil || !strings.Contains(err.Error(), "can only be attached when status is enabled") {
		t.Fatalf("precondition must short-circuit, got %v", err)
	}
	if strings.Contains(err.Error(), ";") && strings.Count(err.Error(), "consent_") > 1 {
		t.Fatalf("precondition must not be batched with a checklist: %q", err.Error())
	}
}
