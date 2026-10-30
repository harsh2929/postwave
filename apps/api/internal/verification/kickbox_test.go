// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func kbServer(t *testing.T, handler http.HandlerFunc) *KickboxVerifier {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &KickboxVerifier{
		APIKey: "test-key",
		testHooks: &providerTestHooks{
			baseURL: srv.URL,
			client:  srv.Client(),
		},
	}
}

func TestKickboxMapsDeliverableToValid(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"deliverable","reason":"accepted_email","role":false,
			"free":false,"disposable":false,"accept_all":false,"sendex":0.98,
			"email":"a@b.com","user":"a","domain":"b.com","success":true}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusValid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusValid)
	}
	if got.Provider != ProviderKickbox {
		t.Fatalf("Provider = %q, want %q", got.Provider, ProviderKickbox)
	}
	if !got.Billable {
		t.Fatal("a vendor call must be marked Billable")
	}
}

func TestKickboxMapsUndeliverableToInvalid(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"undeliverable","reason":"rejected_email","success":true,
			"email":"a@b.com","domain":"b.com"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusInvalid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusInvalid)
	}
	if got.SubStatus != SubStatusMailboxNotFound {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusMailboxNotFound)
	}
}

func TestKickboxMapsRiskyAcceptAllToCatchAll(t *testing.T) {
	// Kickbox has no "catch_all" result; it reports risky + accept_all.
	// Collapsing that to plain "risky" would lose the single most
	// actionable distinction in the whole vocabulary.
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"risky","reason":"low_deliverability","accept_all":true,
			"sendex":0.5,"success":true,"email":"a@b.com","domain":"b.com"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusCatchAll {
		t.Fatalf("Status = %q, want %q", got.Status, StatusCatchAll)
	}
	if got.SubStatus != SubStatusAcceptAll {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusAcceptAll)
	}
}

func TestKickboxMapsRiskyDisposableToDoNotMail(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"risky","reason":"low_quality","disposable":true,
			"success":true,"email":"a@b.com","domain":"b.com"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusDoNotMail {
		t.Fatalf("Status = %q, want %q", got.Status, StatusDoNotMail)
	}
	if got.SubStatus != SubStatusDisposable {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusDisposable)
	}
	if !got.Disposable {
		t.Fatal("Disposable flag not propagated")
	}
}

func TestKickboxMapsRiskyRoleToCautionaryUnknown(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"risky","reason":"low_deliverability","role":true,
			"success":true,"email":"support@b.com","domain":"b.com"}`)
	})

	got, err := v.Verify(context.Background(), "support@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusUnknown || got.SubStatus != SubStatusRoleBased {
		t.Fatalf("role result = (%q,%q), want (%q,%q)",
			got.Status, got.SubStatus, StatusUnknown, SubStatusRoleBased)
	}
	if !got.RoleAccount {
		t.Fatal("RoleAccount flag not propagated")
	}
}

func TestKickboxKeepsDeliverableRoleValid(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"deliverable","reason":"accepted_email","role":true,
			"success":true,"email":"sales@b.com","domain":"b.com"}`)
	})

	got, err := v.Verify(context.Background(), "sales@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusValid || got.SubStatus != SubStatusRoleBased || !got.RoleAccount {
		t.Fatalf("deliverable role result = %+v, want valid with advisory role flag", got)
	}
}

func TestKickboxConvertsSendexToTenPointScore(t *testing.T) {
	// Kickbox's sendex is 0..1; our canonical Score is the 0..10 scale
	// the rest of the platform (and ZeroBounce) speaks.
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"risky","reason":"low_deliverability","accept_all":true,
			"sendex":0.62,"success":true,"email":"a@b.com","domain":"b.com"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Score == nil {
		t.Fatal("Score = nil, want a converted sendex")
	}
	if *got.Score != 6 {
		t.Fatalf("Score = %d, want 6 (0.62 -> 0..10)", *got.Score)
	}
}

func TestKickboxOmitsScoreWhenSendexAbsent(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"unknown","reason":"timeout","success":true,"email":"a@b.com"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Score != nil {
		t.Fatalf("Score = %d, want nil when the provider sent no sendex", *got.Score)
	}
	if got.SubStatus != SubStatusTimeoutExceeded {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusTimeoutExceeded)
	}
}

func TestKickboxSurfacesDidYouMean(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"result":"undeliverable","reason":"invalid_domain",
			"did_you_mean":"bill@gmail.com","success":true,"email":"bill@gamil.com"}`)
	})

	got, err := v.Verify(context.Background(), "bill@gamil.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.DidYouMean != "bill@gmail.com" {
		t.Fatalf("DidYouMean = %q", got.DidYouMean)
	}
	if got.SubStatus != SubStatusNoDNSEntries {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusNoDNSEntries)
	}
}

func TestKickboxTreatsSuccessFalseAsProviderError(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"success":false,"message":"Invalid API key"}`)
	})

	_, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestKickboxMixedFailureAndVerdictIsPartial(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"success":false,"message":"Invalid API key",`+
			`"result":"deliverable","email":"a@b.com"}`)
	})
	got, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("Verify result=%+v error=%v, want partial unauthorized response", got, err)
	}
}

func TestKickboxRejectsMalformedSuccessfulVerifyShapesAsAmbiguous(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fixture string
	}{
		{name: "empty object", fixture: `{}`},
		{name: "missing result", fixture: `{"success":true,"email":"a@b.com"}`},
		{name: "missing email", fixture: `{"success":true,"result":"deliverable"}`},
		{name: "missing reason", fixture: `{"success":true,"result":"deliverable","email":"a@b.com"}`},
		{name: "unknown reason", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","reason":"future_terminal_signal"}`},
		{name: "foreign email", fixture: `{"success":true,"result":"deliverable","email":"other@b.com"}`},
		{name: "foreign domain field", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","domain":"foreign.example"}`},
		{name: "foreign user field", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","user":"other"}`},
		{name: "unknown provider status", fixture: `{"success":true,"result":"future_canary","email":"a@b.com"}`},
		{name: "deliverable plus disposable", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","reason":"accepted_email","disposable":true}`},
		{name: "deliverable plus accept all", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","reason":"accepted_email","accept_all":true}`},
		{name: "deliverable plus invalid reason", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","reason":"invalid_domain"}`},
		{name: "risky disposable plus accept all", fixture: `{"success":true,"result":"risky","email":"a@b.com","reason":"low_deliverability","disposable":true,"accept_all":true}`},
		{name: "risky accept all plus invalid domain", fixture: `{"success":true,"result":"risky","email":"a@b.com","accept_all":true,"reason":"invalid_domain"}`},
		{name: "risky role plus toxic reason", fixture: `{"success":true,"result":"risky","email":"a@b.com","role":true,"reason":"low_quality"}`},
		{name: "sendex above range", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","sendex":1.1}`},
		{name: "sendex below range", fixture: `{"success":true,"result":"deliverable","email":"a@b.com","sendex":-0.1}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := kbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.fixture)
			})
			got, err := v.Verify(context.Background(), "a@b.com")
			if !errors.Is(err, ErrProviderPartialOutcome) {
				t.Fatalf("Verify result=%+v error=%v, want ErrProviderPartialOutcome", got, err)
			}
			if strings.Contains(err.Error(), "future_canary") || strings.Contains(err.Error(), "foreign.example") {
				t.Fatalf("malformed provider error exposed response detail: %v", err)
			}
		})
	}
}

func TestKickboxTreatsInsufficientBalanceAsNoCredits(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = io.WriteString(w, `{"success":false,"message":"Insufficient balance"}`)
	})

	_, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrNoCredits) {
		t.Fatalf("err = %v, want ErrNoCredits", err)
	}
}

func TestKickboxBalanceParsesNumericBalance(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"success":true,"balance":54321}`)
	})

	got, err := v.Credits(context.Background())
	if err != nil {
		t.Fatalf("Credits: %v", err)
	}
	if got != 54321 {
		t.Fatalf("Credits = %d, want 54321", got)
	}
}

func TestKickboxBalanceRequiresExplicitNonnegativeIntegerSuccess(t *testing.T) {
	for _, tc := range []struct {
		name    string
		fixture string
	}{
		{name: "empty object", fixture: `{}`},
		{name: "missing balance", fixture: `{"success":true}`},
		{name: "null balance", fixture: `{"success":true,"balance":null}`},
		{name: "negative balance", fixture: `{"success":true,"balance":-1}`},
		{name: "fractional balance", fixture: `{"success":true,"balance":1.5}`},
		{name: "string balance", fixture: `{"success":true,"balance":"12"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := kbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.fixture)
			})
			if got, err := v.Credits(context.Background()); !errors.Is(err, ErrProviderUnavailable) {
				t.Fatalf("Credits=%d error=%v, want ErrProviderUnavailable", got, err)
			}
		})
	}

	v := kbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"success":true,"balance":0}`)
	})
	if got, err := v.Credits(context.Background()); err != nil || got != 0 {
		t.Fatalf("explicit zero balance=%d error=%v", got, err)
	}
}

func TestKickboxSendsAPIKeyAsQueryParam(t *testing.T) {
	var gotKey, gotEmail string
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.URL.Query().Get("apikey")
		gotEmail = r.URL.Query().Get("email")
		_, _ = io.WriteString(w, `{"result":"deliverable","reason":"accepted_email","success":true,"email":"a@b.com"}`)
	})

	if _, err := v.Verify(context.Background(), "a@b.com"); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if gotKey != "test-key" || gotEmail != "a@b.com" {
		t.Fatalf("apikey=%q email=%q", gotKey, gotEmail)
	}
}

func TestKickboxBatchPreservesOrderAndBoundsConcurrency(t *testing.T) {
	// Kickbox has no synchronous batch endpoint, so the driver fans
	// out. Unbounded fan-out on a 1000-address batch would open 1000
	// sockets and get us rate-limited.
	var inflight, peak int64
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		cur := atomic.AddInt64(&inflight, 1)
		for {
			old := atomic.LoadInt64(&peak)
			if cur <= old || atomic.CompareAndSwapInt64(&peak, old, cur) {
				break
			}
		}
		defer atomic.AddInt64(&inflight, -1)
		email := r.URL.Query().Get("email")
		_, _ = io.WriteString(w, `{"result":"deliverable","reason":"accepted_email","success":true,"email":"`+email+`"}`)
	})

	in := make([]string, 40)
	for i := range in {
		in[i] = string(rune('a'+i%26)) + string(rune('a'+i/26)) + "@x.com"
	}

	got, err := v.VerifyBatch(context.Background(), in)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if len(got) != len(in) {
		t.Fatalf("len = %d, want %d", len(got), len(in))
	}
	for i := range in {
		if got[i].Email != in[i] {
			t.Fatalf("got[%d].Email = %q, want %q", i, got[i].Email, in[i])
		}
	}
	if peak > int64(kickboxBatchConcurrency) {
		t.Fatalf("peak concurrency %d exceeded the %d cap", peak, kickboxBatchConcurrency)
	}
}

func TestKickboxBatchDoesNotDispatchQueuedWorkAfterFatalResponse(t *testing.T) {
	var calls atomic.Int64
	firstWaveReady := make(chan struct{})
	var closeFirstWave sync.Once
	client := &http.Client{Transport: providerRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if calls.Add(1) == int64(kickboxBatchConcurrency) {
			closeFirstWave.Do(func() { close(firstWaveReady) })
		}
		if req.URL.Query().Get("email") == "auth@example.com" {
			select {
			case <-firstWaveReady:
			case <-time.After(2 * time.Second):
				t.Error("initial Kickbox worker window did not fill")
			}
			return &http.Response{
				StatusCode: http.StatusUnauthorized,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"message":"invalid api key"}`)),
				Request:    req,
			}, nil
		}
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	v := &KickboxVerifier{
		APIKey: "test-key",
		testHooks: &providerTestHooks{
			baseURL: "https://kickbox.invalid",
			client:  client,
		},
	}
	emails := make([]string, 40)
	emails[0] = "auth@example.com"
	for i := 1; i < len(emails); i++ {
		emails[i] = fmt.Sprintf("person-%d@example.com", i)
	}

	got, err := v.VerifyBatch(context.Background(), emails)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("VerifyBatch error = %v, want ErrUnauthorized", err)
	}
	if got != nil {
		t.Fatalf("fatal batch returned results: %+v", got)
	}
	if gotCalls := calls.Load(); gotCalls != int64(kickboxBatchConcurrency) {
		t.Fatalf("provider calls = %d, want only the %d already-in-flight requests",
			gotCalls, kickboxBatchConcurrency)
	}
}

func TestKickboxBatchDoesNotDispatchQueuedWorkAfterAmbiguousResponse(t *testing.T) {
	var calls atomic.Int64
	firstWaveReady := make(chan struct{})
	var closeFirstWave sync.Once
	client := &http.Client{Transport: providerRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		if calls.Add(1) == int64(kickboxBatchConcurrency) {
			closeFirstWave.Do(func() { close(firstWaveReady) })
		}
		if req.URL.Query().Get("email") == "ambiguous@example.com" {
			select {
			case <-firstWaveReady:
			case <-time.After(2 * time.Second):
				t.Error("initial Kickbox worker window did not fill")
			}
			return &http.Response{
				StatusCode: http.StatusInternalServerError,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"message":"temporary failure"}`)),
				Request:    req,
			}, nil
		}
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	v := &KickboxVerifier{
		APIKey: "test-key",
		testHooks: &providerTestHooks{
			baseURL: "https://kickbox.invalid",
			client:  client,
		},
	}
	emails := make([]string, 40)
	emails[0] = "ambiguous@example.com"
	for i := 1; i < len(emails); i++ {
		emails[i] = fmt.Sprintf("person-%d@example.com", i)
	}

	got, err := v.VerifyBatch(context.Background(), emails)
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("VerifyBatch error = %v, want ErrProviderUnavailable", err)
	}
	if got != nil {
		t.Fatalf("ambiguous batch returned results: %+v", got)
	}
	if gotCalls := calls.Load(); gotCalls != int64(kickboxBatchConcurrency) {
		t.Fatalf("provider calls = %d, want only the %d already-in-flight requests",
			gotCalls, kickboxBatchConcurrency)
	}
}

func TestKickboxBatchMarksSuccessfulNeighborAsPartialAfterAmbiguity(t *testing.T) {
	err := kickboxBatchOutcomeError(nil, ErrProviderUnavailable, 1)
	if !errors.Is(err, ErrProviderUnavailable) || !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("batch outcome error=%v, want unavailable plus partial markers", err)
	}
}

func TestKickboxBatchReturnsAmbiguityErrorAndDropsPartialResults(t *testing.T) {
	// A 5xx may arrive after the provider accepted and charged the request.
	// Returning an unbilled unknown would make a retry look safe when it is not.
	v := kbServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("email") == "boom@x.com" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(w, `{"result":"deliverable","reason":"accepted_email","success":true,"email":"`+r.URL.Query().Get("email")+`"}`)
	})

	got, err := v.VerifyBatch(context.Background(), []string{"ok@x.com", "boom@x.com"})
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("VerifyBatch error = %v, want ErrProviderUnavailable", err)
	}
	if got != nil {
		t.Fatalf("ambiguous batch returned durable-looking partials: %+v", got)
	}
}

func TestKickboxBatchRejectsForeignProviderAddressesAsAmbiguous(t *testing.T) {
	v := kbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w,
			`{"result":"deliverable","reason":"accepted_email","success":true,"email":"foreign@example.com"}`)
	})
	got, err := v.VerifyBatch(context.Background(), []string{"a@example.com", "b@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("VerifyBatch result=%+v error=%v, want ErrProviderPartialOutcome", got, err)
	}
	if got != nil {
		t.Fatalf("foreign provider addresses returned settled-looking results: %+v", got)
	}
}

func TestKickboxBatchCombinesSettledFatalCredentialErrorAndAmbiguity(t *testing.T) {
	// Scheduling cannot guarantee that two concurrent responses settle before
	// either one cancels the batch. Exercise the deterministic outcome combiner
	// directly for the case where both were already observed.
	err := kickboxBatchOutcomeError(ErrUnauthorized, ErrProviderUnavailable, 0)
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("batch outcome error = %v, want fatal ErrUnauthorized", err)
	}
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("batch outcome error = %v, want partial/ambiguous markers", err)
	}
}

func TestKickboxBatchMarksFatalAfterSuccessAsPartial(t *testing.T) {
	err := kickboxBatchOutcomeError(ErrUnauthorized, nil, 1)
	if !errors.Is(err, ErrUnauthorized) || !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("batch outcome error = %v, want unauthorized partial outcome", err)
	}
}

func TestKickboxNameIsStable(t *testing.T) {
	v := &KickboxVerifier{}
	if v.Name() != ProviderKickbox {
		t.Fatalf("Name() = %q, want %q", v.Name(), ProviderKickbox)
	}
}

func TestKickboxRequiresAPIKey(t *testing.T) {
	v := &KickboxVerifier{}
	if _, err := v.Verify(context.Background(), "a@b.com"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}
