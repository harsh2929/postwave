// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func zbServer(t *testing.T, handler http.HandlerFunc) (*ZeroBounceVerifier, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &ZeroBounceVerifier{
		APIKey: "test-key",
		testHooks: &providerTestHooks{
			baseURL: srv.URL,
			bulkURL: srv.URL,
			client:  srv.Client(),
		},
	}, srv
}

func TestZeroBounceMapsValidResponse(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{
			"address":"jill@aol.com","status":"valid","sub_status":"",
			"free_email":true,"did_you_mean":null,"account":"jill","domain":"aol.com",
			"mx_found":"true","mx_record":"mx-aol.mail.gm0.yahoodns.net",
			"firstname":"Jill","lastname":"Stein","gender":"female",
			"country":"United States","city":"Seattle"
		}`)
	})

	got, err := v.Verify(context.Background(), "jill@aol.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusValid {
		t.Fatalf("Status = %q, want %q", got.Status, StatusValid)
	}
	if !got.Billable {
		t.Fatal("a vendor call must be marked Billable")
	}
	if got.Provider != ProviderZeroBounce {
		t.Fatalf("Provider = %q, want %q", got.Provider, ProviderZeroBounce)
	}
	if !got.MXFound {
		t.Fatal(`mx_found:"true" (a JSON string) did not parse to bool true`)
	}
	if got.FirstName != "Jill" || got.LastName != "Stein" || got.Gender != "female" {
		t.Fatalf("enrichment not mapped: %+v", got)
	}
	if got.City != "Seattle" || got.Country != "United States" {
		t.Fatalf("geo not mapped: %+v", got)
	}
}

func TestZeroBounceMapsCurrentValidAdvisorySubStatuses(t *testing.T) {
	for _, subStatus := range []SubStatus{
		SubStatusAlternate, SubStatusGold, SubStatusAIAgentMailbox,
	} {
		t.Run(string(subStatus), func(t *testing.T) {
			v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"address":"a@b.com","status":"valid","sub_status":"`+
					string(subStatus)+`","mx_found":"true"}`)
			})
			got, err := v.Verify(context.Background(), "a@b.com")
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Status != StatusValid || got.SubStatus != subStatus {
				t.Fatalf("result = %+v, want valid/%s", got, subStatus)
			}
		})
	}
}

func TestZeroBounceMapsProviderValidAcceptAllSignalsToCatchAll(t *testing.T) {
	for _, tc := range []struct {
		sub  SubStatus
		role bool
	}{
		{sub: SubStatusAcceptAll},
		{sub: SubStatusRoleBasedAcceptAll, role: true},
	} {
		t.Run(string(tc.sub), func(t *testing.T) {
			v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"address":"sales@b.com","status":"valid","sub_status":"`+
					string(tc.sub)+`","mx_found":"true"}`)
			})
			got, err := v.Verify(context.Background(), "sales@b.com")
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Status != StatusCatchAll || got.SubStatus != tc.sub || got.RoleAccount != tc.role {
				t.Fatalf("result = %+v, want catch_all/%s role=%t", got, tc.sub, tc.role)
			}
		})
	}
}

func TestZeroBounceLeadingPeriodRewritePreservesRequestedIdentityAsTypo(t *testing.T) {
	for _, domain := range []string{"gmail.com", "googlemail.com"} {
		t.Run(domain, func(t *testing.T) {
			v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, `{"address":"person@`+domain+`","account":"person","domain":"`+domain+`",`+
					`"status":"valid","sub_status":"leading_period_removed","mx_found":"true"}`)
			})
			requested := ".person@" + domain
			suggestion := "person@" + domain
			got, err := v.Verify(context.Background(), requested)
			if err != nil {
				t.Fatalf("Verify: %v", err)
			}
			if got.Email != requested || got.Status != StatusInvalid ||
				got.SubStatus != SubStatusPossibleTypo || got.DidYouMean != suggestion {
				t.Fatalf("identity-safe leading-period result = %+v", got)
			}
		})
	}
}

func TestZeroBounceBatchLeadingPeriodRewriteSupportsGoogleMailboxDomains(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"email_batch":[`+
			`{"address":"first@gmail.com","status":"valid","sub_status":"leading_period_removed"},`+
			`{"address":"second@googlemail.com","status":"valid","sub_status":"leading_period_removed"}`+
			`],"errors":[]}`)
	})
	requested := []string{".first@gmail.com", ".second@googlemail.com"}
	got, err := v.VerifyBatch(context.Background(), requested)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	for i, result := range got {
		if result.Email != requested[i] || result.Status != StatusInvalid ||
			result.SubStatus != SubStatusPossibleTypo || result.DidYouMean != requested[i][1:] {
			t.Fatalf("result[%d] = %+v, want identity-safe typo", i, result)
		}
	}
}

func TestZeroBounceRejectsUnrelatedLeadingPeriodRewrite(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"address":"other@gmail.com","status":"valid",`+
			`"sub_status":"leading_period_removed"}`)
	})
	got, err := v.Verify(context.Background(), ".person@gmail.com")
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("Verify result=%+v error=%v, want ambiguous foreign rewrite", got, err)
	}
}

func TestZeroBounceRejectsCrossDomainLeadingPeriodRewrite(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"address":"person@gmail.com","status":"valid",`+
			`"sub_status":"leading_period_removed"}`)
	})
	got, err := v.Verify(context.Background(), ".person@googlemail.com")
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("Verify result=%+v error=%v, want ambiguous cross-domain rewrite", got, err)
	}
}

func TestZeroBounceKeepsMXForwardDoNotMail(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"address":"a@b.com","status":"do_not_mail",`+
			`"sub_status":"mx_forward","mx_found":"true"}`)
	})
	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusDoNotMail || got.SubStatus != SubStatusMXForward {
		t.Fatalf("result = %+v, want do_not_mail/mx_forward", got)
	}
}

func TestZeroBounceUnknownIsNotReportedAsCharged(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"address":"slow@example.com","status":"unknown","sub_status":"timeout_exceeded"}`)
	})

	got, err := v.Verify(context.Background(), "slow@example.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusUnknown || got.Billable {
		t.Fatalf("unknown result = %+v, want canonical unknown and billable=false", got)
	}
}

func TestZeroBounceMapsHyphenatedCatchAllToCanonicalStatus(t *testing.T) {
	// ZeroBounce spells it "catch-all"; our canonical vocabulary uses
	// "catch_all". Getting this wrong silently degrades every
	// catch-all address to "unknown".
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"address":"a@b.com","status":"catch-all","sub_status":"","mx_found":"true"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusCatchAll {
		t.Fatalf("Status = %q, want %q", got.Status, StatusCatchAll)
	}
}

func TestZeroBounceRoleDoNotMailRemainsB2BCautionary(t *testing.T) {
	for _, tc := range []struct {
		sub  string
		want Status
	}{
		{sub: string(SubStatusRoleBased), want: StatusUnknown},
		{sub: string(SubStatusRoleBasedCatchAll), want: StatusCatchAll},
	} {
		v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, `{"address":"sales@b.com","status":"do_not_mail","sub_status":"`+tc.sub+`","mx_found":"true"}`)
		})
		got, err := v.Verify(context.Background(), "sales@b.com")
		if err != nil {
			t.Fatalf("Verify(%s): %v", tc.sub, err)
		}
		if got.Status != tc.want || !got.RoleAccount || !got.Billable {
			t.Fatalf("role result for %s = %+v, want status=%q role=true measured vendor credit", tc.sub, got, tc.want)
		}
	}
}

func TestZeroBounceMapsSpamtrap(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"address":"t@b.com","status":"spamtrap","sub_status":"possible_trap","mx_found":"true"}`)
	})

	got, err := v.Verify(context.Background(), "t@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.Status != StatusSpamtrap {
		t.Fatalf("Status = %q, want %q", got.Status, StatusSpamtrap)
	}
	if got.SubStatus != SubStatusPossibleTrap {
		t.Fatalf("SubStatus = %q, want %q", got.SubStatus, SubStatusPossibleTrap)
	}
	if got.Sendable() {
		t.Fatal("a spamtrap must never be reported sendable")
	}
}

func TestZeroBounceMapsDoNotMailAndUnknownStatuses(t *testing.T) {
	cases := map[string]Status{
		"do_not_mail": StatusDoNotMail,
		"abuse":       StatusAbuse,
		"invalid":     StatusInvalid,
		"unknown":     StatusUnknown,
	}
	for vendor, want := range cases {
		v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, `{"address":"a@b.com","status":"`+vendor+`","mx_found":"false"}`)
		})
		got, err := v.Verify(context.Background(), "a@b.com")
		if err != nil {
			t.Fatalf("Verify(%s): %v", vendor, err)
		}
		if got.Status != want {
			t.Errorf("status %q mapped to %q, want %q", vendor, got.Status, want)
		}
	}
}

func TestZeroBounceUnrecognisedStatusIsSpendAmbiguous(t *testing.T) {
	// A new provider status may still consume a credit. Treating it as the
	// documented unbilled "unknown" would erase that distinction.
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"address":"a@b.com","status":"some_new_status","mx_found":"true"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("Verify result=%+v error=%v, want ErrProviderPartialOutcome", got, err)
	}
	if strings.Contains(err.Error(), "some_new_status") {
		t.Fatalf("error exposed raw provider status: %v", err)
	}
}

func TestZeroBounceRejectsMalformedSuccessfulVerifyShapesAsAmbiguous(t *testing.T) {
	for _, tc := range []struct {
		name, fixture string
	}{
		{name: "empty object", fixture: `{}`},
		{name: "missing address", fixture: `{"status":"valid"}`},
		{name: "foreign address", fixture: `{"address":"other@b.com","status":"valid"}`},
		{name: "foreign account", fixture: `{"address":"a@b.com","account":"other","status":"valid"}`},
		{name: "missing status", fixture: `{"address":"a@b.com"}`},
		{name: "unknown sub status", fixture: `{"address":"a@b.com","status":"valid","sub_status":"future_terminal_signal"}`},
		{name: "postwave local-only sub status", fixture: `{"address":"a@b.com","status":"unknown","sub_status":"no_mailbox_probe"}`},
		{name: "postwave outage-only sub status", fixture: `{"address":"a@b.com","status":"unknown","sub_status":"provider_unavailable"}`},
		{name: "valid plus disposable", fixture: `{"address":"a@b.com","status":"valid","sub_status":"disposable"}`},
		{name: "valid plus toxic", fixture: `{"address":"a@b.com","status":"valid","sub_status":"toxic"}`},
		{name: "valid plus global suppression", fixture: `{"address":"a@b.com","status":"valid","sub_status":"global_suppression"}`},
		{name: "valid plus role catch all", fixture: `{"address":"a@b.com","status":"valid","sub_status":"role_based_catch_all"}`},
		{name: "do not mail plus catch all", fixture: `{"address":"a@b.com","status":"do_not_mail","sub_status":"accept_all"}`},
		{name: "catch all plus disposable", fixture: `{"address":"a@b.com","status":"catch-all","sub_status":"disposable"}`},
		{name: "unknown plus mailbox missing", fixture: `{"address":"a@b.com","status":"unknown","sub_status":"mailbox_not_found"}`},
		{name: "malformed json", fixture: `{"address":`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.fixture)
			})
			got, err := v.Verify(context.Background(), "a@b.com")
			if !errors.Is(err, ErrProviderPartialOutcome) {
				t.Fatalf("Verify result=%+v error=%v, want ErrProviderPartialOutcome", got, err)
			}
		})
	}
}

func TestZeroBounceSurfacesDidYouMean(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"address":"a@gmial.com","status":"invalid","sub_status":"possible_typo","did_you_mean":"a@gmail.com","mx_found":"false"}`)
	})

	got, err := v.Verify(context.Background(), "a@gmial.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.DidYouMean != "a@gmail.com" {
		t.Fatalf("DidYouMean = %q, want %q", got.DidYouMean, "a@gmail.com")
	}
}

func TestZeroBounceTreatsNullDidYouMeanAsEmpty(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"address":"a@b.com","status":"valid","did_you_mean":null,"mx_found":"true"}`)
	})

	got, err := v.Verify(context.Background(), "a@b.com")
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.DidYouMean != "" {
		t.Fatalf("DidYouMean = %q, want empty for JSON null", got.DidYouMean)
	}
}

func TestZeroBounceDetectsInvalidAPIKeyEnvelope(t *testing.T) {
	// ZeroBounce reports auth failure as HTTP 200 with an error body.
	// Treating that as a verdict would mark every address unknown and
	// silently burn a job.
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"error":"Invalid API Key"}`)
	})

	_, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestZeroBounceDoesNotGuessCombinedAccountRejection(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"error":"Invalid API Key or your account ran out of credits"}`)
	})

	_, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrProviderAccountRejected) {
		t.Fatalf("err = %v, want ErrProviderAccountRejected", err)
	}
	if errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v guessed quota or credential state", err)
	}
}

func TestZeroBounceMixedSingleErrorAndVerdictIsPartial(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"error":"Invalid API Key or your account ran out of credits",`+
			`"address":"a@b.com","status":"valid"}`)
	})
	got, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrProviderAccountRejected) {
		t.Fatalf("Verify result=%+v error=%v, want partial account rejection", got, err)
	}
}

func TestZeroBounceMapsServerErrorToProviderUnavailable(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})

	_, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("err = %v, want ErrProviderUnavailable", err)
	}
}

func TestZeroBounceSendsAPIKeyAsQueryParam(t *testing.T) {
	var gotKey, gotEmail string
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.URL.Query().Get("api_key")
		gotEmail = r.URL.Query().Get("email")
		_, _ = io.WriteString(w, `{"address":"a@b.com","status":"valid","mx_found":"true"}`)
	})

	if _, err := v.Verify(context.Background(), "a@b.com"); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if gotKey != "test-key" {
		t.Fatalf("api_key = %q, want %q", gotKey, "test-key")
	}
	if gotEmail != "a@b.com" {
		t.Fatalf("email = %q, want %q", gotEmail, "a@b.com")
	}
}

func TestZeroBounceCreditsParsesStringBalance(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"Credits":"12345"}`)
	})

	got, err := v.Credits(context.Background())
	if err != nil {
		t.Fatalf("Credits: %v", err)
	}
	if got != 12345 {
		t.Fatalf("Credits = %d, want 12345", got)
	}
}

func TestZeroBounceCreditsNegativeOneMeansUnauthorized(t *testing.T) {
	// The documented sentinel for "bad key" on this endpoint.
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"Credits":"-1"}`)
	})

	_, err := v.Credits(context.Background())
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestZeroBounceBatchPreservesInputOrder(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Answer deliberately out of order — the driver must realign
		// results to the caller's input order by address.
		_, _ = io.WriteString(w, `{"email_batch":[
			{"address":"c@x.com","status":"invalid","mx_found":"false"},
			{"address":"a@x.com","status":"valid","mx_found":"true"},
			{"address":"b@x.com","status":"catch-all","mx_found":"true"}
		],"errors":[]}`)
	})

	in := []string{"a@x.com", "b@x.com", "c@x.com"}
	got, err := v.VerifyBatch(context.Background(), in)
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3", len(got))
	}
	want := []Status{StatusValid, StatusCatchAll, StatusInvalid}
	for i := range want {
		if got[i].Email != in[i] {
			t.Fatalf("got[%d].Email = %q, want %q", i, got[i].Email, in[i])
		}
		if got[i].Status != want[i] {
			t.Fatalf("got[%d].Status = %q, want %q", i, got[i].Status, want[i])
		}
	}
}

func TestZeroBounceOneAddressBatchUsesSingleEndpointAfterDispatchReceipt(t *testing.T) {
	hookCalled := false
	requests := 0
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if !hookCalled {
			t.Error("provider request arrived before the dispatch receipt hook")
		}
		if r.Method != http.MethodGet || r.URL.Path != "/v2/validate" {
			t.Errorf("request = %s %s, want GET /v2/validate", r.Method, r.URL.Path)
		}
		if got := r.URL.Query().Get("email"); got != "one@example.com" {
			t.Errorf("email query = %q, want one@example.com", got)
		}
		if r.URL.Path == "/v2/validatebatch" {
			t.Error("one-address verification used the 70-second batch endpoint")
		}
		_, _ = io.WriteString(w,
			`{"address":"one@example.com","status":"valid","mx_found":"true"}`)
	})
	paces := 0
	v.batchPacer = func(context.Context) error {
		paces++
		return nil
	}
	chain := &Chain{Vendor: v}

	got, stats, err := chain.VerifyBatchWithDispatchHook(context.Background(),
		[]string{"one@example.com"}, func(context.Context, []string) error {
			hookCalled = true
			return nil
		})
	if err != nil {
		t.Fatalf("VerifyBatchWithDispatchHook: %v", err)
	}
	if requests != 1 || len(got) != 1 || got[0].Status != StatusValid {
		t.Fatalf("requests=%d results=%+v", requests, got)
	}
	if stats.CreditsSpent != 1 {
		t.Fatalf("stats=%+v, want one measured provider credit", stats)
	}
	if paces != 0 {
		t.Fatalf("single-address /validate consumed %d batch pacing slots", paces)
	}
}

func TestZeroBounceBatchDetectsDocumentedGlobalErrorEnvelope(t *testing.T) {
	tests := []struct {
		name    string
		fixture string
		want    error
	}{
		{
			name: "documented ambiguous account rejection",
			fixture: `{"email_batch":[],"errors":[{"error":"Invalid API Key or your account ran out of credits",` +
				`"email_address":"all"}]}`,
			want: ErrProviderAccountRejected,
		},
		{
			name:    "invalid credential",
			fixture: `{"email_batch":[],"errors":[{"error":"Invalid API Key","email_address":"all"}]}`,
			want:    ErrUnauthorized,
		},
		{
			name:    "unclassified global failure",
			fixture: `{"email_batch":[],"errors":[{"error":"Request failed","email_address":"all"}]}`,
			want:    ErrProviderUnavailable,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.fixture)
			})
			got, err := v.VerifyBatch(context.Background(), []string{"a@example.com", "b@example.com"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("VerifyBatch error = %v, want %v", err, tc.want)
			}
			if tc.want == ErrProviderAccountRejected &&
				(errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized)) {
				t.Fatalf("VerifyBatch error = %v guessed quota or credential state", err)
			}
			if got != nil {
				t.Fatalf("global provider error returned results: %+v", got)
			}
		})
	}
}

func TestZeroBounceBatchTreatsPerAddressErrorsAsSpendAmbiguous(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w,
			`{"email_batch":[{"address":"good@example.com","status":"valid","mx_found":"true"}],`+
				`"errors":[{"error":"Invalid email address","email_address":"bad@example.com"}]}`)
	})

	got, err := v.VerifyBatch(context.Background(), []string{"bad@example.com", "good@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("VerifyBatch result=%+v error=%v, want ErrProviderPartialOutcome", got, err)
	}
	if got != nil {
		t.Fatalf("per-address error returned a settled-looking batch: %+v", got)
	}
}

func TestZeroBounceBatchRejectsMalformedDuplicateAndForeignRowsAsAmbiguous(t *testing.T) {
	for _, tc := range []struct {
		name, fixture string
	}{
		{name: "empty object", fixture: `{}`},
		{name: "row missing address", fixture: `{"email_batch":[` +
			`{"status":"valid"},{"address":"b@example.com","status":"valid"}],"errors":[]}`},
		{name: "row missing status", fixture: `{"email_batch":[` +
			`{"address":"a@example.com"},{"address":"b@example.com","status":"valid"}],"errors":[]}`},
		{name: "unsupported status", fixture: `{"email_batch":[` +
			`{"address":"a@example.com","status":"future_canary"},` +
			`{"address":"b@example.com","status":"valid"}],"errors":[]}`},
		{name: "duplicate row", fixture: `{"email_batch":[` +
			`{"address":"a@example.com","status":"valid"},` +
			`{"address":"a@example.com","status":"valid"},` +
			`{"address":"b@example.com","status":"valid"}],"errors":[]}`},
		{name: "foreign row", fixture: `{"email_batch":[` +
			`{"address":"a@example.com","status":"valid"},` +
			`{"address":"b@example.com","status":"valid"},` +
			`{"address":"foreign@example.com","status":"valid"}],"errors":[]}`},
		{name: "duplicate error and row", fixture: `{"email_batch":[` +
			`{"address":"a@example.com","status":"valid"}],` +
			`"errors":[{"error":"bad","email_address":"a@example.com"},` +
			`{"error":"bad","email_address":"b@example.com"}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, tc.fixture)
			})
			got, err := v.VerifyBatch(context.Background(), []string{"a@example.com", "b@example.com"})
			if !errors.Is(err, ErrProviderPartialOutcome) {
				t.Fatalf("VerifyBatch result=%+v error=%v, want ErrProviderPartialOutcome", got, err)
			}
			if got != nil {
				t.Fatalf("malformed batch returned settled-looking results: %+v", got)
			}
			if strings.Contains(err.Error(), "future_canary") || strings.Contains(err.Error(), "foreign@example.com") {
				t.Fatalf("error exposed raw provider detail: %v", err)
			}
		})
	}
}

func TestZeroBounceMixedGlobalRejectionAndRowsIsPartial(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"email_batch":[{"address":"a@example.com","status":"valid"}],`+
			`"errors":[{"error":"Invalid API Key or your account ran out of credits",`+
			`"email_address":"all"}]}`)
	})
	got, err := v.VerifyBatch(context.Background(), []string{"a@example.com", "b@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrProviderAccountRejected) {
		t.Fatalf("VerifyBatch result=%+v error=%v, want partial account rejection", got, err)
	}
}

func TestZeroBounceMixedTopLevelBatchErrorAndRowsIsPartial(t *testing.T) {
	v, _ := zbServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"error":"Invalid API Key or your account ran out of credits",`+
			`"email_batch":[{"address":"a@example.com","status":"valid"}],"errors":[]}`)
	})
	got, err := v.VerifyBatch(context.Background(), []string{"a@example.com", "b@example.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) || !errors.Is(err, ErrProviderAccountRejected) {
		t.Fatalf("VerifyBatch result=%+v error=%v, want partial account rejection", got, err)
	}
}

func TestZeroBounceBatchChunksAboveProviderLimit(t *testing.T) {
	var requests int
	var seen int
	var paces int
	var receipts int
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if paces != requests || receipts != requests {
			t.Errorf("request %d crossed egress before pace/receipt: paces=%d receipts=%d",
				requests, paces, receipts)
		}
		var body struct {
			EmailBatch []struct {
				EmailAddress string `json:"email_address"`
			} `json:"email_batch"`
			Timeout int `json:"timeout"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode batch body: %v", err)
		}
		if len(body.EmailBatch) > zeroBounceMaxBatch {
			t.Errorf("chunk of %d exceeds provider limit %d", len(body.EmailBatch), zeroBounceMaxBatch)
		}
		if body.Timeout != zeroBounceBatchProviderTimeoutSeconds {
			t.Errorf("provider timeout=%d, want %d", body.Timeout, zeroBounceBatchProviderTimeoutSeconds)
		}
		seen += len(body.EmailBatch)
		var sb strings.Builder
		sb.WriteString(`{"email_batch":[`)
		for i, e := range body.EmailBatch {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString(`{"address":"` + e.EmailAddress + `","status":"valid","mx_found":"true"}`)
		}
		sb.WriteString(`],"errors":[]}`)
		_, _ = io.WriteString(w, sb.String())
	})
	v.batchPacer = func(context.Context) error {
		paces++
		return nil
	}

	in := make([]string, zeroBounceMaxBatch+5)
	for i := range in {
		in[i] = "u" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + "@x.com"
	}

	got, err := v.verifyBatchWithDispatchHook(context.Background(), in,
		func(_ context.Context, chunk []string) error {
			receipts++
			if len(chunk) > zeroBounceMaxBatch {
				t.Fatalf("dispatch receipt covered %d rows, max %d", len(chunk), zeroBounceMaxBatch)
			}
			return nil
		})
	if err != nil {
		t.Fatalf("VerifyBatch: %v", err)
	}
	if requests < 2 {
		t.Fatalf("requests = %d, want the batch split across at least 2 calls", requests)
	}
	if seen != len(in) {
		t.Fatalf("provider saw %d addresses, want %d", seen, len(in))
	}
	if len(got) != len(in) {
		t.Fatalf("len = %d, want %d", len(got), len(in))
	}
	if paces != requests || receipts != requests {
		t.Fatalf("requests=%d paces=%d receipts=%d, want one of each per chunk",
			requests, paces, receipts)
	}
}

func TestZeroBounceCanceledPacingDoesNotWriteReceiptOrEgress(t *testing.T) {
	requests := 0
	v, _ := zbServer(t, func(http.ResponseWriter, *http.Request) { requests++ })
	v.batchPacer = func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	receipts := 0
	got, err := v.verifyBatchWithDispatchHook(ctx,
		[]string{"a@example.com", "b@example.com"},
		func(context.Context, []string) error {
			receipts++
			return nil
		})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("result=%+v error=%v, want context cancellation", got, err)
	}
	if receipts != 0 || requests != 0 {
		t.Fatalf("canceled pacing wrote receipts=%d and provider requests=%d", receipts, requests)
	}
}

func TestZeroBounceBatchStopsBeforeNextChunkWhenFirstChunkOmitsAddress(t *testing.T) {
	requests := 0
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		var body struct {
			EmailBatch []struct {
				EmailAddress string `json:"email_address"`
			} `json:"email_batch"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode batch body: %v", err)
		}
		limit := len(body.EmailBatch)
		if requests == 1 {
			limit--
		}
		rows := make([]map[string]string, 0, limit)
		for _, item := range body.EmailBatch[:limit] {
			rows = append(rows, map[string]string{
				"address": item.EmailAddress,
				"status":  "valid",
			})
		}
		if err := json.NewEncoder(w).Encode(map[string]any{
			"email_batch": rows,
			"errors":      []any{},
		}); err != nil {
			t.Fatalf("encode batch response: %v", err)
		}
	})

	emails := make([]string, zeroBounceMaxBatch+1)
	for i := range emails {
		emails[i] = fmt.Sprintf("person-%d@example.com", i)
	}
	got, err := v.VerifyBatch(context.Background(), emails)
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("VerifyBatch error = %v, want ErrProviderPartialOutcome", err)
	}
	if got != nil {
		t.Fatalf("incomplete first chunk returned results: %+v", got)
	}
	if requests != 1 {
		t.Fatalf("provider requests = %d, want 1; later chunks must not be dispatched", requests)
	}
}

func TestZeroBounceBatchMarksGlobalAccountRejectionAfterCompletedChunkPartial(t *testing.T) {
	requests := 0
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 2 {
			_, _ = io.WriteString(w,
				`{"email_batch":[],"errors":[{"error":"Invalid API Key or your account ran out of credits",`+
					`"email_address":"all"}]}`)
			return
		}
		var body struct {
			EmailBatch []struct {
				EmailAddress string `json:"email_address"`
			} `json:"email_batch"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode first chunk: %v", err)
		}
		var response strings.Builder
		response.WriteString(`{"email_batch":[`)
		for i, item := range body.EmailBatch {
			if i > 0 {
				response.WriteByte(',')
			}
			response.WriteString(`{"address":"` + item.EmailAddress + `","status":"valid","mx_found":"true"}`)
		}
		response.WriteString(`],"errors":[]}`)
		_, _ = io.WriteString(w, response.String())
	})

	emails := make([]string, zeroBounceMaxBatch+1)
	for i := range emails {
		emails[i] = fmt.Sprintf("person-%d@example.com", i)
	}
	got, err := v.VerifyBatch(context.Background(), emails)
	if !errors.Is(err, ErrProviderAccountRejected) || !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("VerifyBatch error = %v, want account-rejection plus partial-outcome markers", err)
	}
	if errors.Is(err, ErrNoCredits) || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("VerifyBatch error = %v guessed quota or credential state", err)
	}
	if got != nil {
		t.Fatalf("partial multi-chunk batch returned results: %+v", got)
	}
}

func TestZeroBounceBatchTreatsMissingResultsAsSpendAmbiguous(t *testing.T) {
	// The provider may have charged for the omitted address. A synthetic
	// unbillable unknown would make the whole batch look safely settled.
	v, _ := zbServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"email_batch":[{"address":"a@x.com","status":"valid","mx_found":"true"}],"errors":[]}`)
	})

	got, err := v.VerifyBatch(context.Background(), []string{"a@x.com", "missing@x.com"})
	if !errors.Is(err, ErrProviderPartialOutcome) {
		t.Fatalf("VerifyBatch error = %v, want ErrProviderPartialOutcome", err)
	}
	if got != nil {
		t.Fatalf("missing provider slot returned a false settled batch: %+v", got)
	}
}

func TestZeroBounceNameIsStable(t *testing.T) {
	v := &ZeroBounceVerifier{}
	if v.Name() != ProviderZeroBounce {
		t.Fatalf("Name() = %q, want %q", v.Name(), ProviderZeroBounce)
	}
}

func TestZeroBounceRequiresAPIKey(t *testing.T) {
	v := &ZeroBounceVerifier{}
	_, err := v.Verify(context.Background(), "a@b.com")
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("err = %v, want ErrNotConfigured", err)
	}
}
