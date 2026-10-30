// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"net/http/httptest"
	"testing"
	"time"
)

// The changes query keys cannot see.
//
// Keys are scoped `[resource, tenantId, role, ...]`, which stops one workspace's
// cache reaching another. They cannot catch a change WITHIN one tenant id — and
// those are the changes that matter most, because the person is still sitting
// in front of the same screen.

func base() ContextEpochInputs {
	at := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	return ContextEpochInputs{
		TenantID:        "11111111-1111-1111-1111-111111111111",
		TenantTier:      "studio",
		TenantUpdatedAt: at,
		UserID:          "22222222-2222-2222-2222-222222222222",
		UserRole:        "editor",
		UserStatus:      "active",
		UserUpdatedAt:   at,
	}
}

func TestADemotionChangesTheEpoch(t *testing.T) {
	// The case the key shape misses entirely: same tenant, same user, same
	// keys — but the cached campaigns list is the one they could edit a moment
	// ago, and the UI still offers the buttons that went with it.
	before := ComputeContextEpoch(base())
	demoted := base()
	demoted.UserRole = "viewer"
	if ComputeContextEpoch(demoted) == before {
		t.Fatal("demoting an editor to viewer left the epoch unchanged")
	}
}

func TestSuspensionChangesTheEpoch(t *testing.T) {
	before := ComputeContextEpoch(base())
	suspended := base()
	suspended.UserStatus = "suspended"
	if ComputeContextEpoch(suspended) == before {
		t.Fatal("suspending the user left the epoch unchanged")
	}
}

func TestAPlanChangeChangesTheEpoch(t *testing.T) {
	// Features appear and disappear with the plan, and cached capability
	// answers would otherwise keep saying the old thing.
	before := ComputeContextEpoch(base())
	upgraded := base()
	upgraded.TenantTier = "pro"
	if ComputeContextEpoch(upgraded) == before {
		t.Fatal("a plan change left the epoch unchanged")
	}
}

func TestARemoveAndReAddChangesTheEpoch(t *testing.T) {
	// Same role, same tenant — only the row's updated_at moved. That is the
	// only trace a remove/re-add leaves, and it has to be enough.
	before := ComputeContextEpoch(base())
	readded := base()
	readded.UserUpdatedAt = readded.UserUpdatedAt.Add(time.Hour)
	if ComputeContextEpoch(readded) == before {
		t.Fatal("a membership change left the epoch unchanged")
	}
}

func TestTheEpochIsStableForAnUnchangedContext(t *testing.T) {
	// It has to be stable, or every response would invalidate every cache and
	// the mechanism would be indistinguishable from having no cache at all.
	first, again := ComputeContextEpoch(base()), ComputeContextEpoch(base())
	if first != again {
		t.Fatal("the same context produced two different epochs")
	}
}

func TestTheEpochLeaksNothingReadable(t *testing.T) {
	// It is echoed to the browser on every response. A client has no business
	// reading when an admin last edited a user record, and a token that exposes
	// it invites something to start parsing it.
	epoch := ComputeContextEpoch(base())
	for _, secret := range []string{"editor", "studio", "active", "2222", "1111"} {
		if contains(epoch, secret) {
			t.Fatalf("epoch %q exposes %q", epoch, secret)
		}
	}
}

func TestAnAnonymousResponseHasNoEpoch(t *testing.T) {
	// A stable token for "nobody" would let two signed-out sessions match on
	// it, which is the opposite of the point.
	if got := ComputeContextEpoch(ContextEpochInputs{}); got != "" {
		t.Fatalf("anonymous epoch = %q, want empty", got)
	}
	rec := httptest.NewRecorder()
	WriteContextEpoch(rec, "")
	if rec.Header().Get(ContextEpochHeader) != "" {
		t.Fatal("an empty epoch was still written as a header")
	}
}

func TestTheHeaderDoesNotAddAVary(t *testing.T) {
	// This test used to assert the OPPOSITE, and the assertion was wrong.
	//
	// `Vary` lists REQUEST header names — it tells a cache which parts of the
	// request select this response. `X-Postwave-Context-Epoch` travels one way,
	// server to client; no client sends it, and grepping all three apps
	// confirms none ever has. Naming it in `Vary` could therefore never key any
	// cache, while reading as a control that was being enforced.
	//
	// It was also being deleted downstream: `httpcache.Conditional` rebuilds
	// the header map on both the 200 and 304 paths, so the value did not reach
	// the wire even when it was set.
	//
	// What actually does this job is the `Vary: Cookie, Authorization` the
	// cache policy already sets — the CREDENTIAL is the request-side input that
	// selects the context, which is the whole point.
	rec := httptest.NewRecorder()
	rec.Header().Set("Vary", "Accept-Encoding")
	WriteContextEpoch(rec, "ce1-abc")

	vary := rec.Header().Get("Vary")
	if contains(vary, ContextEpochHeader) {
		t.Errorf("Vary=%q names a response-only header, which cannot key a cache", vary)
	}
	if !contains(vary, "Accept-Encoding") {
		t.Errorf("Vary=%q dropped a value it did not set", vary)
	}
	if rec.Header().Get(ContextEpochHeader) != "ce1-abc" {
		t.Error("the epoch header itself must still be written")
	}
}
func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		(haystack == needle || indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

func countOccurrences(h, n string) int {
	count, i := 0, 0
	for i+len(n) <= len(h) {
		if h[i:i+len(n)] == n {
			count++
			i += len(n)
			continue
		}
		i++
	}
	return count
}
