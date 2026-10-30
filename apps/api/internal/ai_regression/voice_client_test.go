// SPDX-License-Identifier: AGPL-3.0-only
package ai_regression

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPRegressionVoiceClientReplayBatchStrictHappyPath(t *testing.T) {
	t.Parallel()
	request := testVoiceRequest()
	results, completion := testVoiceReceipt(request)
	var called atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, got *http.Request) {
		called.Add(1)
		if got.Method != http.MethodPost {
			t.Errorf("method = %q, want POST", got.Method)
		}
		if got.URL.Path != "/v1/voice/regression/replay-batch" {
			t.Errorf("path = %q", got.URL.Path)
		}
		if got.Header.Get("Authorization") != "Bearer internal-test-token" {
			t.Errorf("authorization header = %q", got.Header.Get("Authorization"))
		}
		if got.Header.Get("X-Tenant-ID") != "tenant-1" {
			t.Errorf("tenant header = %q", got.Header.Get("X-Tenant-ID"))
		}
		if got.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content type = %q", got.Header.Get("Content-Type"))
		}
		if got.Header.Get("Accept") != "application/x-ndjson" {
			t.Errorf("accept = %q", got.Header.Get("Accept"))
		}
		var decoded VoiceReplayRequest
		decoder := json.NewDecoder(got.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&decoded); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if !reflect.DeepEqual(decoded, request) {
			t.Errorf("request = %#v, want %#v", decoded, request)
		}
		writer.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		_, _ = io.WriteString(writer, testVoiceStream(t, results, completion))
	}))
	defer server.Close()

	client := NewHTTPRegressionVoiceClient(server.URL+"/", "internal-test-token")
	batch, err := client.ReplayBatch(context.Background(), "tenant-1", request)
	if err != nil {
		t.Fatalf("ReplayBatch() error = %v", err)
	}
	if called.Load() != 1 {
		t.Fatalf("calls = %d, want 1", called.Load())
	}
	if len(batch.Results) != len(results) || batch.Results[0].ExampleID != results[0].ExampleID {
		t.Fatalf("results = %#v, want %#v", batch.Results, results)
	}
	if batch.Completion.ExpectedExamples != len(request.Examples) || batch.Completion.Runtime != request.ExpectedRuntime {
		t.Fatalf("completion = %#v", batch.Completion)
	}
}

func TestHTTPRegressionVoiceClientRejectsInvalidRequestBeforeNetwork(t *testing.T) {
	t.Parallel()
	valid := testVoiceRequest()
	tests := []struct {
		name   string
		mutate func(*VoiceReplayRequest)
	}{
		{"no examples", func(request *VoiceReplayRequest) { request.Examples = nil }},
		{"duplicate id", func(request *VoiceReplayRequest) { request.Examples = append(request.Examples, request.Examples[0]) }},
		{"invalid surface", func(request *VoiceReplayRequest) { request.Examples[0].SurfaceKind = "anything" }},
		{"empty brief", func(request *VoiceReplayRequest) { request.Examples[0].Brief = "   " }},
		{"empty approved output", func(request *VoiceReplayRequest) { request.Examples[0].ApprovedOutput = "   " }},
		{"invalid runtime", func(request *VoiceReplayRequest) { request.ExpectedRuntime.ModelID = "model\nname" }},
		{"threshold out of bounds", func(request *VoiceReplayRequest) { request.WarnThreshold = 101 }},
		{"threshold non-finite", func(request *VoiceReplayRequest) { request.WarnThreshold = math.NaN() }},
		{"too many examples", func(request *VoiceReplayRequest) {
			for len(request.Examples) <= voiceReplayMaxExamples {
				next := request.Examples[0]
				next.ID = "example-" + strings.Repeat("x", len(request.Examples))
				request.Examples = append(request.Examples, next)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := valid
			request.Examples = append([]VoiceReplayExample(nil), valid.Examples...)
			test.mutate(&request)
			var calls atomic.Int32
			client := &HTTPRegressionVoiceClient{
				BaseURL:          "http://voice.invalid",
				InternalAPIToken: "internal-test-token",
				HTTP: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
					calls.Add(1)
					return nil, errors.New("network must not be used")
				})},
			}
			_, err := client.ReplayBatch(context.Background(), "tenant-1", request)
			if !errors.Is(err, ErrVoiceInvalidResponse) {
				t.Fatalf("ReplayBatch() error = %v, want ErrVoiceInvalidResponse", err)
			}
			if calls.Load() != 0 {
				t.Fatalf("network calls = %d, want 0", calls.Load())
			}
		})
	}
}

func TestVoiceReplayRequestSerializesAndValidatesZeroWarnThreshold(t *testing.T) {
	t.Parallel()
	request := testVoiceRequest()
	request.WarnThreshold = 0
	request.Examples = []VoiceReplayExample{{
		ID: "golden-zero", SurfaceKind: SurfaceCampaignDraft,
		Brief: "Write a bounded zero-threshold fixture.", ApprovedOutput: "Approved fixture.",
	}}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"warn_threshold":0`) {
		t.Fatalf("zero threshold was omitted from the signed request body: %s", encoded)
	}
	zero := 0.0
	completion := VoiceReplayCompletion{
		Runtime:          request.ExpectedRuntime,
		ExpectedExamples: 1,
		ScoredExamples:   1,
		Aggregate: VoiceBatchAggregate{
			Total: 1, Scored: 1, Passed: 1, MeanScore: &zero, P25Score: &zero,
			BySurface: map[string]VoiceSurfaceAggregate{
				SurfaceCampaignDraft: {Total: 1, Scored: 1, Passed: 1, MeanScore: &zero},
			},
		},
	}
	results := []VoiceReplayResult{{
		ExampleID: "golden-zero", SurfaceKind: SurfaceCampaignDraft,
		FidelityScore: &zero, Breakdown: testVoiceBreakdown(zero), Severity: "ok",
	}}
	if err := validateVoiceCompletion(completion, results, request.WarnThreshold); err != nil {
		t.Fatalf("zero-threshold completion was rejected: %v", err)
	}
	batch, err := decodeVoiceReplayStream(strings.NewReader(testVoiceStream(t, results, completion)), request)
	if err != nil || len(batch.Results) != 1 || batch.Results[0].Severity != "ok" {
		t.Fatalf("zero-threshold stream receipt=%+v err=%v", batch, err)
	}
}

func TestValidVoiceReplayRequestUsesCharacterBoundsForUnicodeReferences(t *testing.T) {
	t.Parallel()
	request := testVoiceRequest()
	request.Examples = []VoiceReplayExample{{
		ID:             "golden-unicode",
		SurfaceKind:    SurfaceCampaignDraft,
		Brief:          strings.Repeat("界", maxBriefLen),
		ApprovedOutput: strings.Repeat("é", maxOutputLen),
	}}
	if !validVoiceReplayRequest(request) {
		t.Fatal("valid multibyte character bounds rejected")
	}
	request.Examples[0].ApprovedOutput += "é"
	if validVoiceReplayRequest(request) {
		t.Fatal("approved output over the character bound was accepted")
	}
}

func TestHTTPRegressionVoiceClientAuthenticationAndStatusBoundaries(t *testing.T) {
	t.Parallel()
	request := testVoiceRequest()
	t.Run("missing token never contacts voice", func(t *testing.T) {
		var calls atomic.Int32
		client := &HTTPRegressionVoiceClient{
			BaseURL: "http://voice.invalid",
			HTTP: &http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
				calls.Add(1)
				return nil, errors.New("network must not be used")
			})},
		}
		_, err := client.ReplayBatch(context.Background(), "tenant-1", request)
		if !errors.Is(err, ErrVoiceAuthenticationUnavailable) {
			t.Fatalf("error = %v", err)
		}
		if calls.Load() != 0 {
			t.Fatalf("network calls = %d, want 0", calls.Load())
		}
	})

	for _, test := range []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, ErrVoiceAuthenticationUnavailable},
		{http.StatusForbidden, ErrVoiceAuthenticationUnavailable},
		{http.StatusConflict, ErrVoiceRuntimeMismatch},
		{http.StatusUnprocessableEntity, ErrVoicePrerequisiteUnavailable},
		{http.StatusTooManyRequests, ErrVoiceQuotaExceeded},
		{http.StatusInternalServerError, ErrVoiceUnavailable},
		{http.StatusBadRequest, ErrVoiceInvalidResponse},
	} {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
				_, _ = io.WriteString(writer, "private provider diagnostic: token=do-not-leak")
			}))
			defer server.Close()
			client := NewHTTPRegressionVoiceClient(server.URL, "internal-test-token")
			_, err := client.ReplayBatch(context.Background(), "tenant-1", request)
			if !errors.Is(err, test.want) || strings.Contains(err.Error(), "do-not-leak") {
				t.Fatalf("error = %v, want safe %v", err, test.want)
			}
		})
	}
}

func TestHTTPRegressionVoiceClientRefusesRedirects(t *testing.T) {
	t.Parallel()
	var redirected atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect-target" {
			redirected.Add(1)
		}
		http.Redirect(writer, request, "/redirect-target", http.StatusFound)
	}))
	defer server.Close()

	client := NewHTTPRegressionVoiceClient(server.URL, "internal-test-token")
	_, err := client.ReplayBatch(context.Background(), "tenant-1", testVoiceRequest())
	if !errors.Is(err, ErrVoiceInvalidResponse) {
		t.Fatalf("error = %v, want ErrVoiceInvalidResponse", err)
	}
	if redirected.Load() != 0 {
		t.Fatalf("redirect target contacted %d times", redirected.Load())
	}
}

func TestHTTPRegressionVoiceClientRejectsInvalidStreams(t *testing.T) {
	t.Parallel()
	request := testVoiceRequest()
	results, completion := testVoiceReceipt(request)
	valid := testVoiceStream(t, results, completion)
	resultLine := testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: voiceReplaySchemaVersion, Type: "result", Sequence: 1, Result: &results[0]})

	wrongRuntime := completion
	wrongRuntime.Runtime.ModelID = "another-model"
	wrongAggregate := completion
	wrongAggregate.Aggregate.Passed++
	wrongSurface := results[0]
	wrongSurface.SurfaceKind = SurfaceReplyIntent
	unknownID := results[0]
	unknownID.ExampleID = "never-requested"
	wrongSequence := results[0]
	wrongSeverityResults := append([]VoiceReplayResult(nil), results...)
	wrongSeverityResults[0].Severity = "critical"
	wrongBreakdown := results[0]
	wrongBreakdownValue := *wrongBreakdown.Breakdown
	wrongBreakdownValue.Combined = 12
	wrongBreakdown.Breakdown = &wrongBreakdownValue
	missingBreakdown := results[0]
	missingBreakdown.Breakdown = nil

	tests := []struct {
		name        string
		contentType string
		body        string
	}{
		{"malformed json", "application/x-ndjson", "{" + "\n"},
		{"truncated json", "application/x-ndjson", strings.TrimSuffix(resultLine, "}") + "\n"},
		{"missing completion", "application/x-ndjson", resultLine + "\n"},
		{"unknown example id", "application/x-ndjson", testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: 2, Type: "result", Sequence: 1, Result: &unknownID}) + "\n"},
		{"duplicate example id", "application/x-ndjson", resultLine + "\n" + testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: 2, Type: "result", Sequence: 2, Result: &results[0]}) + "\n"},
		{"wrong surface", "application/x-ndjson", testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: 2, Type: "result", Sequence: 1, Result: &wrongSurface}) + "\n"},
		{"wrong runtime", "application/x-ndjson", testVoiceStream(t, results, wrongRuntime)},
		{"wrong sequence", "application/x-ndjson", testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: 2, Type: "result", Sequence: 2, Result: &wrongSequence}) + "\n"},
		{"severity contradicts frozen threshold", "application/x-ndjson", testVoiceStream(t, wrongSeverityResults, completion)},
		{"unknown json field", "application/x-ndjson", strings.TrimSuffix(resultLine, "}") + `,"unexpected":true}` + "\n"},
		{"unknown breakdown field", "application/x-ndjson", strings.Replace(resultLine, `"combined":90`, `"combined":90,"provider_payload":"private"`, 1) + "\n"},
		{"mismatched breakdown score", "application/x-ndjson", testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: 2, Type: "result", Sequence: 1, Result: &wrongBreakdown}) + "\n"},
		{"missing scored breakdown", "application/x-ndjson", testVoiceLine(t, voiceReplayEnvelope{SchemaVersion: 2, Type: "result", Sequence: 1, Result: &missingBreakdown}) + "\n"},
		{"aggregate mismatch", "application/x-ndjson", testVoiceStream(t, results, wrongAggregate)},
		{"data after completion", "application/x-ndjson", valid + resultLine + "\n"},
		{"wrong content type", "application/json", valid},
		{"oversized line", "application/x-ndjson", strings.Repeat("x", voiceReplayMaxLineBytes+1) + "\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", test.contentType)
				_, _ = io.WriteString(writer, test.body)
			}))
			defer server.Close()
			client := NewHTTPRegressionVoiceClient(server.URL, "internal-test-token")
			_, err := client.ReplayBatch(context.Background(), "tenant-1", request)
			if !errors.Is(err, ErrVoiceInvalidResponse) {
				t.Fatalf("ReplayBatch() error = %v, want ErrVoiceInvalidResponse", err)
			}
		})
	}
}

func TestHTTPRegressionVoiceClientReturnsCallerCancellation(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	client := &HTTPRegressionVoiceClient{
		BaseURL:          "http://voice.invalid",
		InternalAPIToken: "internal-test-token",
		HTTP: &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			close(started)
			<-request.Context().Done()
			return nil, request.Context().Err()
		})},
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := client.ReplayBatch(ctx, "tenant-1", testVoiceRequest())
		done <- err
	}()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ReplayBatch did not return after context cancellation")
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func testVoiceRequest() VoiceReplayRequest {
	return VoiceReplayRequest{
		ExpectedRuntime: VoiceRuntimeIdentity{Provider: "google", ModelID: "gemini-test", PromptPolicyVersion: "voice-regression-replay-v2"},
		WarnThreshold:   60,
		Examples: []VoiceReplayExample{
			{ID: "golden-1", SurfaceKind: SurfaceCampaignDraft, Brief: "Write an onboarding campaign.", ApprovedOutput: "Welcome aboard."},
			{ID: "golden-2", SurfaceKind: SurfaceSubjectLine, Brief: "Write a concise subject line.", ApprovedOutput: "A better welcome."},
		},
	}
}

func testVoiceReceipt(request VoiceReplayRequest) ([]VoiceReplayResult, VoiceReplayCompletion) {
	first, second := 90.0, 70.0
	results := []VoiceReplayResult{
		{ExampleID: request.Examples[0].ID, SurfaceKind: request.Examples[0].SurfaceKind, ReplayedOutput: "Welcome aboard.", FidelityScore: &first, Breakdown: testVoiceBreakdown(first), Severity: "ok"},
		{ExampleID: request.Examples[1].ID, SurfaceKind: request.Examples[1].SurfaceKind, ReplayedOutput: "A better welcome.", FidelityScore: &second, Breakdown: testVoiceBreakdown(second), Severity: "ok"},
	}
	mean, p25 := 80.0, 70.0
	completion := VoiceReplayCompletion{
		Runtime: request.ExpectedRuntime, ExpectedExamples: len(request.Examples), ScoredExamples: 2,
		Aggregate: VoiceBatchAggregate{Total: 2, Scored: 2, Passed: 2, MeanScore: &mean, P25Score: &p25, BySurface: map[string]VoiceSurfaceAggregate{
			SurfaceCampaignDraft: {Total: 1, Scored: 1, Passed: 1, MeanScore: &first},
			SurfaceSubjectLine:   {Total: 1, Scored: 1, Passed: 1, MeanScore: &second},
		}},
	}
	return results, completion
}

func testVoiceBreakdown(score float64) *VoiceFidelityBreakdown {
	return &VoiceFidelityBreakdown{
		EmbeddingSimilarity: score / 100,
		StylisticDistance:   score / 100,
		VocabularyOverlap:   score / 100,
		StructuralMatch:     score / 100,
		Combined:            score,
	}
}

func testVoiceStream(testingT *testing.T, results []VoiceReplayResult, completion VoiceReplayCompletion) string {
	testingT.Helper()
	lines := make([]string, 0, len(results)+1)
	for index := range results {
		result := results[index]
		lines = append(lines, testVoiceLine(testingT, voiceReplayEnvelope{SchemaVersion: voiceReplaySchemaVersion, Type: "result", Sequence: index + 1, Result: &result}))
	}
	lines = append(lines, testVoiceLine(testingT, voiceReplayEnvelope{SchemaVersion: voiceReplaySchemaVersion, Type: "complete", Sequence: len(results) + 1, Complete: &completion}))
	return strings.Join(lines, "\n") + "\n"
}

func testVoiceLine(testingT *testing.T, envelope voiceReplayEnvelope) string {
	testingT.Helper()
	encoded, err := json.Marshal(envelope)
	if err != nil {
		testingT.Fatalf("marshal stream line: %v", err)
	}
	return string(encoded)
}
