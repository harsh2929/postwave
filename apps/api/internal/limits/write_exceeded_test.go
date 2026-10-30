// SPDX-License-Identifier: AGPL-3.0-only
package limits

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// `WriteExceeded` is the primary site converted to the shared denial contract —
// and an adversarial review found it had NO test at all. Mutations that left
// the whole suite green: deleting `Resource` from the constructor, deleting
// `Tier`, renaming a wire key. The headline site's wire contract was unverified.

func decodeDenial(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var env map[string]map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, rec.Body.String())
	}
	return env["error"]
}

func TestWriteExceededEmitsThePlanDenialContract(t *testing.T) {
	rec := httptest.NewRecorder()
	err := &Error{Resource: ResourceContacts, Tier: "studio", Limit: 2000, Current: 2000}
	if !WriteExceeded(rec, err) {
		t.Fatal("a limits.Error must be recognised")
	}
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402", rec.Code)
	}
	got := decodeDenial(t, rec)
	for key, want := range map[string]any{
		"code":     "plan_limit_exceeded",
		"reason":   "plan",
		"resource": string(ResourceContacts),
		"tier":     "studio",
		"remedy":   "upgrade_plan",
	} {
		if got[key] != want {
			t.Errorf("%s = %v, want %v", key, got[key], want)
		}
	}
	// Numbers survive the JSON round-trip as numbers, not strings.
	if got["limit"] != float64(2000) || got["current"] != float64(2000) {
		t.Errorf("limit/current = %v/%v, want 2000/2000", got["limit"], got["current"])
	}
	// Headers are part of the contract: a denial must never be cached, and a
	// JSON body must not be content-sniffed.
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", rec.Header().Get("Cache-Control"))
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("missing nosniff")
	}
}

func TestWriteExceededOffersNoUpgradeOnTheTopTier(t *testing.T) {
	// `pro` is the highest plan. Telling a pro tenant to upgrade points at a
	// button that does not exist; an empty remedy says "you cannot self-serve
	// this", which is true.
	rec := httptest.NewRecorder()
	err := &Error{Resource: ResourceMonthlySends, Tier: "pro", Limit: 500000, Current: 500000}
	if !WriteExceeded(rec, err) {
		t.Fatal("a limits.Error must be recognised")
	}
	if remedy, present := decodeDenial(t, rec)["remedy"]; present {
		t.Fatalf("remedy = %v on the top tier; there is nothing to upgrade to", remedy)
	}
}

func TestWriteExceededIgnoresUnrelatedErrors(t *testing.T) {
	rec := httptest.NewRecorder()
	if WriteExceeded(rec, errors.New("something else")) {
		t.Fatal("a non-limits error must not be written as a plan denial")
	}
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatal("nothing should have been written")
	}
}
