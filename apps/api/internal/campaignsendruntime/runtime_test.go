// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaigndelivery"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/campaignplanbuilder"
	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

type runtimeArtifactReader struct {
	revision                           campaignartifact.Revision
	plan                               campaignartifact.Plan
	artifacts                          []campaignartifact.Artifact
	revisionErr, planErr, artifactsErr error
}

func (r *runtimeArtifactReader) GetRevision(context.Context, string, string, string) (*campaignartifact.Revision, error) {
	if r.revisionErr != nil {
		return nil, r.revisionErr
	}
	value := r.revision
	return &value, nil
}
func (r *runtimeArtifactReader) GetPlan(context.Context, string, string, string) (*campaignartifact.Plan, error) {
	if r.planErr != nil {
		return nil, r.planErr
	}
	value := r.plan
	return &value, nil
}
func (r *runtimeArtifactReader) ListArtifacts(context.Context, string, string, string) ([]campaignartifact.Artifact, error) {
	if r.artifactsErr != nil {
		return nil, r.artifactsErr
	}
	return append([]campaignartifact.Artifact(nil), r.artifacts...), nil
}

type runtimeAssuranceReader struct {
	manifest campaignassurance.ClaimedRun
	err      error
}

type runtimeGate struct {
	mu      sync.Mutex
	receipt campaignassurancegate.Receipt
	err     error
	calls   int
}

func (g *runtimeGate) ReauthorizeBound(_ context.Context, _ campaignassurancegate.Request) (campaignassurancegate.Receipt, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	if g.err != nil {
		return campaignassurancegate.Receipt{}, g.err
	}
	receipt := g.receipt
	receipt.OverrideIDs = append([]string(nil), receipt.OverrideIDs...)
	return receipt, nil
}

func (r *runtimeAssuranceReader) GetRunManifest(context.Context, string, string) (*campaignassurance.ClaimedRun, error) {
	if r.err != nil {
		return nil, r.err
	}
	value := r.manifest
	return &value, nil
}

type runtimeObjectReader struct{ values map[string][]byte }

func (r *runtimeObjectReader) Get(_ context.Context, _ string, rest string) (io.ReadCloser, string, error) {
	return io.NopCloser(bytes.NewReader(r.values[rest])), "message/rfc822", nil
}

type runtimeRecipientResolver struct {
	values RecipientValues
	err    error
}

func (r *runtimeRecipientResolver) ResolveRecipient(_ context.Context, input RecipientResolveInput) (RecipientValues, error) {
	if r.err != nil {
		return RecipientValues{}, r.err
	}
	return RecipientValues{Locale: r.values.Locale, Slots: cloneSlotsForTest(r.values.Slots)}, nil
}

type runtimePollMinter struct {
	tenantID, campaignID, contentRevisionID, recipientReference string
	document                                                    semanticemail.DocumentV2
	issuedAt                                                    time.Time
	links                                                       semanticemail.PollOptionLinks
	err                                                         error
}

func (m *runtimePollMinter) MintLinks(
	_ context.Context,
	tenantID, campaignID, contentRevisionID, recipientReference string, issuedAt time.Time,
	document semanticemail.DocumentV2,
) (semanticemail.PollOptionLinks, error) {
	m.tenantID, m.campaignID = tenantID, campaignID
	m.contentRevisionID, m.recipientReference = contentRevisionID, recipientReference
	m.issuedAt = issuedAt
	m.document = document
	if m.err != nil {
		return nil, m.err
	}
	return m.links, nil
}

type runtimeCoordinator struct {
	mu       sync.Mutex
	requests []campaigndelivery.Request
	err      error
	mutate   func(*campaigndelivery.Attempt)
}

func (c *runtimeCoordinator) Dispatch(_ context.Context, request campaigndelivery.Request) (campaigndelivery.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	request.Message.RFC822 = append([]byte(nil), request.Message.RFC822...)
	c.requests = append(c.requests, request)
	if c.err != nil {
		return campaigndelivery.Result{}, c.err
	}
	attempt := campaigndelivery.Attempt{ID: request.Attempt.DeliveryID, AttemptInput: request.Attempt, State: campaigndelivery.StateAccepted}
	if c.mutate != nil {
		c.mutate(&attempt)
	}
	return campaigndelivery.Result{Attempt: attempt, Replayed: len(c.requests) > 1}, nil
}

type runtimeFixture struct {
	runtime     *Runtime
	input       sending.BoundDispatchInput
	artifacts   *runtimeArtifactReader
	assurance   *runtimeAssuranceReader
	gate        *runtimeGate
	objects     *runtimeObjectReader
	recipients  *runtimeRecipientResolver
	coordinator *runtimeCoordinator
}

func TestDispatchBoundCompilesExactRecipientBytesAndReplaysWithoutDrift(t *testing.T) {
	fixture := newRuntimeFixture(t)
	first, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if err != nil {
		t.Fatalf("first dispatch: %v", err)
	}
	second, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if err != nil {
		t.Fatalf("replay dispatch: %v", err)
	}
	if first.Status != sending.BoundDispatchAccepted || first.Replayed ||
		second.Status != sending.BoundDispatchAccepted || !second.Replayed {
		t.Fatalf("outcomes = first %+v, second %+v", first, second)
	}
	if len(fixture.coordinator.requests) != 2 {
		t.Fatalf("coordinator calls = %d", len(fixture.coordinator.requests))
	}
	left, right := fixture.coordinator.requests[0], fixture.coordinator.requests[1]
	if !bytes.Equal(left.Message.RFC822, right.Message.RFC822) || left.Message.MIMEHash != right.Message.MIMEHash ||
		left.Attempt.IdempotencyKey != right.Attempt.IdempotencyKey || left.Attempt.MessageID != right.Attempt.MessageID {
		t.Fatal("identical bound recipient did not reproduce exact delivery request")
	}
	if digestBytes(left.Message.RFC822) != left.Message.MIMEHash || left.Attempt.OutboundMIMEHash != left.Message.MIMEHash {
		t.Fatal("real MIME hash was not bound end-to-end")
	}
	parsed, err := mail.ReadMessage(bytes.NewReader(left.Message.RFC822))
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Header.Get("To"); !strings.Contains(got, fixture.input.Recipient) {
		t.Fatalf("To = %q", got)
	}
	if got := parsed.Header.Get("Message-ID"); got != left.Attempt.MessageID || got != left.Message.MessageID {
		t.Fatalf("Message-ID = %q, ledger=%q transport=%q", got, left.Attempt.MessageID, left.Message.MessageID)
	}
	parsedReplyTo, err := mail.ParseAddress(parsed.Header.Get("Reply-To"))
	if err != nil || parsedReplyTo.Address != left.Attempt.ReplyTo || left.Message.ReplyTo != left.Attempt.ReplyTo {
		t.Fatalf("Reply-To = %q err=%v ledger=%q transport=%q", parsed.Header.Get("Reply-To"), err, left.Attempt.ReplyTo, left.Message.ReplyTo)
	}
	local := strings.Split(left.Attempt.ReplyTo, "@")[0]
	if len(local) > 64 || !strings.HasPrefix(local, "reply+") {
		t.Fatalf("correlation local-part = %q (%d bytes)", local, len(local))
	}
	for _, leaked := range []string{left.Attempt.TenantID, left.Attempt.CampaignID, left.Attempt.DeliveryID, fixture.input.Recipient} {
		if strings.Contains(left.Attempt.ReplyTo, leaked) {
			t.Fatalf("opaque Reply-To leaked identity %q: %s", leaked, left.Attempt.ReplyTo)
		}
	}
	if parsed.Header.Get("List-Unsubscribe-Post") != "List-Unsubscribe=One-Click" ||
		parsed.Header.Get("X-Postwave-No-Open-Track") != "1" ||
		parsed.Header.Get("X-Postwave-No-Click-Track") != "1" {
		t.Fatalf("recipient-safe headers missing: %#v", parsed.Header)
	}
	if !bytes.Contains(left.Message.RFC822, []byte("Asha")) {
		t.Fatal("real recipient slot value is absent from compiled MIME")
	}
	for _, artifact := range fixture.artifacts.artifacts {
		if bytes.Equal(left.Message.RFC822, fixture.objects.values[mustObjectRest(t, artifact.MIMEObjectRef)]) {
			t.Fatal("runtime sent a synthetic fixture MIME object to the real recipient")
		}
	}
}

func TestDispatchBoundFailsClosedOnStaleOrUnsupportedIdentity(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*runtimeFixture)
		reason string
	}{
		{name: "source hash", mutate: func(f *runtimeFixture) { f.input.Binding.SourceHash = strings.Repeat("f", 64) }, reason: ReasonGateMismatch},
		{name: "plan hash", mutate: func(f *runtimeFixture) { f.input.Binding.PlanHash = strings.Repeat("e", 64) }, reason: ReasonGateMismatch},
		{name: "run attempt", mutate: func(f *runtimeFixture) { f.input.Binding.RunAttempt++ }, reason: ReasonGateMismatch},
		{name: "gate", mutate: func(f *runtimeFixture) { f.input.Binding.GateDecision = "warn" }, reason: ReasonGateMismatch},
		{name: "run artifact receipt", mutate: func(f *runtimeFixture) {
			f.assurance.manifest.Artifacts[0].OutboundMIMEHash = strings.Repeat("1", 64)
		}, reason: ReasonArtifactMismatch},
		{name: "configuration receipt", mutate: func(f *runtimeFixture) {
			f.assurance.manifest.Configurations[0].ConfigurationHash = strings.Repeat("2", 64)
		}, reason: ReasonArtifactMismatch},
		{name: "variant", mutate: func(f *runtimeFixture) { f.input.VariantID = uuid.NewString() }, reason: ReasonVariantUnsupported},
		{name: "locale", mutate: func(f *runtimeFixture) { f.recipients.values.Locale = "fr" }, reason: ReasonLocaleUnsupported},
		{name: "artifact bytes", mutate: func(f *runtimeFixture) {
			for key := range f.objects.values {
				f.objects.values[key] = []byte("tampered")
			}
		}, reason: ReasonArtifactObjectMismatch},
		{name: "expired artifact", mutate: func(f *runtimeFixture) {
			for index := range f.artifacts.artifacts {
				expired := f.artifacts.artifacts[index].CreatedAt
				f.artifacts.artifacts[index].ExpiresAt = &expired
			}
		}, reason: ReasonArtifactObjectUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRuntimeFixture(t)
			test.mutate(fixture)
			result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
			if err == nil || result.Status != sending.BoundDispatchWithheld || result.Reason != test.reason {
				t.Fatalf("result = %+v, err = %v", result, err)
			}
			if len(fixture.coordinator.requests) != 0 {
				t.Fatal("stale/unsupported input crossed the delivery coordinator")
			}
		})
	}
}

func TestDispatchBoundSelectsAnAssuredMissingOptionalScenario(t *testing.T) {
	baseline := newRuntimeFixture(t)
	if result, err := baseline.runtime.DispatchBound(t.Context(), baseline.input); err != nil || result.Status != sending.BoundDispatchAccepted {
		t.Fatalf("baseline result = %+v, err = %v", result, err)
	}
	missing := newRuntimeFixture(t)
	missing.recipients.values.Slots = map[semanticemail.SlotID]string{}
	if result, err := missing.runtime.DispatchBound(t.Context(), missing.input); err != nil || result.Status != sending.BoundDispatchAccepted {
		t.Fatalf("missing result = %+v, err = %v", result, err)
	}
	baselineScenario := baseline.coordinator.requests[0].Attempt.ScenarioID
	missingScenario := missing.coordinator.requests[0].Attempt.ScenarioID
	if baselineScenario == missingScenario {
		t.Fatalf("missing optional recipient reused baseline scenario %q", baselineScenario)
	}
}

func TestDispatchBoundRejectsUnsafeOneClickUnsubscribeHeaders(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]string)
	}{
		{name: "wrong post contract", mutate: func(headers map[string]string) { headers["List-Unsubscribe-Post"] = "no" }},
		{name: "insecure URL", mutate: func(headers map[string]string) { headers["List-Unsubscribe"] = "<http://example.com/unsubscribe>" }},
		{name: "duplicate case variant", mutate: func(headers map[string]string) { headers["list-unsubscribe"] = "<https://example.com/other>" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRuntimeFixture(t)
			test.mutate(fixture.input.Headers)
			result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
			if err == nil || result.Status != sending.BoundDispatchWithheld || result.Reason != ReasonEnvelopeInvalid {
				t.Fatalf("result = %+v, err = %v", result, err)
			}
			if len(fixture.coordinator.requests) != 0 {
				t.Fatal("unsafe unsubscribe headers crossed the delivery coordinator")
			}
		})
	}
}

func TestDispatchBoundClassifiesFrozenLoaderFailures(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*runtimeFixture)
		status sending.BoundDispatchStatus
		reason string
	}{
		{name: "revision not found", mutate: func(f *runtimeFixture) { f.artifacts.revisionErr = campaignartifact.ErrNotFound }, status: sending.BoundDispatchWithheld, reason: ReasonRevisionUnavailable},
		{name: "revision transient", mutate: func(f *runtimeFixture) { f.artifacts.revisionErr = errors.New("temporary") }, status: sending.BoundDispatchRetryable, reason: ReasonRevisionUnavailable},
		{name: "plan not found", mutate: func(f *runtimeFixture) { f.artifacts.planErr = campaignartifact.ErrNotFound }, status: sending.BoundDispatchWithheld, reason: ReasonPlanUnavailable},
		{name: "run not found", mutate: func(f *runtimeFixture) { f.assurance.err = campaignassurance.ErrNotFound }, status: sending.BoundDispatchWithheld, reason: ReasonRunUnavailable},
		{name: "run transient", mutate: func(f *runtimeFixture) { f.assurance.err = errors.New("temporary") }, status: sending.BoundDispatchRetryable, reason: ReasonRunUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRuntimeFixture(t)
			test.mutate(fixture)
			result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
			if err == nil || result.Status != test.status || result.Reason != test.reason {
				t.Fatalf("result = %+v, err = %v", result, err)
			}
			if len(fixture.coordinator.requests) != 0 {
				t.Fatal("loader failure crossed the delivery coordinator")
			}
		})
	}
}

func TestDispatchBoundMapsCoordinatorAmbiguityWithoutRetryPermission(t *testing.T) {
	fixture := newRuntimeFixture(t)
	fixture.coordinator.err = campaigndelivery.ErrDeliveryIndeterminate
	result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if !errorsIs(err, campaigndelivery.ErrDeliveryIndeterminate) ||
		result.Status != sending.BoundDispatchIndeterminate || result.Reason != ReasonDeliveryIndeterminate {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	fixture = newRuntimeFixture(t)
	fixture.coordinator.err = &campaigntransport.SendError{
		Disposition: campaigntransport.FailureDefinitelyNotSent, Err: errorsNew("rejected"),
	}
	result, err = fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if err == nil || result.Status != sending.BoundDispatchRejected || result.Reason != ReasonDeliveryRejected {
		t.Fatalf("rejected result = %+v, err = %v", result, err)
	}
	fixture = newRuntimeFixture(t)
	fixture.coordinator.err = campaigndelivery.ErrAttemptInFlight
	result, err = fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if !errorsIs(err, campaigndelivery.ErrAttemptInFlight) ||
		result.Status != sending.BoundDispatchRetryable || result.Reason != ReasonDeliveryUnavailable {
		t.Fatalf("in-flight result = %+v, err = %v", result, err)
	}
	fixture = newRuntimeFixture(t)
	fixture.coordinator.mutate = func(attempt *campaigndelivery.Attempt) {
		attempt.OutboundMIMEHash = strings.Repeat("0", 64)
	}
	result, err = fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if err == nil || result.Status != sending.BoundDispatchIndeterminate || result.Reason != ReasonDeliveryIndeterminate {
		t.Fatalf("unrelated accepted receipt result = %+v, err = %v", result, err)
	}
}

func TestDispatchBoundReauthorizesBeforeFrozenReadsAndRecipientCompilation(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status sending.BoundDispatchStatus
	}{
		{name: "stale receipt", err: campaignassurancegate.ErrStale, status: sending.BoundDispatchWithheld},
		{name: "revoked override", err: campaignassurancegate.ErrBlocked, status: sending.BoundDispatchWithheld},
		{name: "gate dependency", err: errors.New("database unavailable"), status: sending.BoundDispatchRetryable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newRuntimeFixture(t)
			fixture.gate.err = test.err
			fixture.artifacts.revisionErr = errors.New("frozen artifact read must not run")
			result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
			if err == nil || result.Status != test.status || result.Reason != ReasonGateMismatch {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if fixture.gate.calls != 1 || len(fixture.coordinator.requests) != 0 {
				t.Fatalf("gate calls=%d coordinator calls=%d", fixture.gate.calls, len(fixture.coordinator.requests))
			}
		})
	}
}

func TestDispatchBoundRequiresExactPluralOverrideReceiptParity(t *testing.T) {
	fixture := newRuntimeFixture(t)
	left, right := uuid.NewString(), uuid.NewString()
	if right < left {
		left, right = right, left
	}
	fixture.input.Binding.GateDecision = "overridden"
	fixture.input.Binding.OverrideIDs = []string{left, right}
	fixture.gate.receipt.Decision = "overridden"
	fixture.gate.receipt.OverrideIDs = []string{left, right}
	fixture.assurance.manifest.Run.GateDecision = campaignassurance.GateBlock
	fixture.assurance.manifest.Run.BlockingFindingCount = 2

	// The fake current gate says the second finding's latest waiver changed.
	fixture.gate.receipt.OverrideIDs = []string{left, uuid.NewString()}
	result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if err == nil || result.Status != sending.BoundDispatchWithheld || result.Reason != ReasonGateMismatch {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(fixture.coordinator.requests) != 0 {
		t.Fatal("waiver-set drift crossed the delivery coordinator")
	}
}

func TestDispatchBoundConcurrentReplayKeepsExactRawMIMEIdentity(t *testing.T) {
	fixture := newRuntimeFixture(t)
	const workers = 24
	var wait sync.WaitGroup
	errs := make(chan error, workers)
	for index := 0; index < workers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
			if err != nil || result.Status != sending.BoundDispatchAccepted {
				errs <- fmt.Errorf("dispatch result=%+v err=%w", result, err)
			}
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	fixture.coordinator.mu.Lock()
	requests := append([]campaigndelivery.Request(nil), fixture.coordinator.requests...)
	fixture.coordinator.mu.Unlock()
	if len(requests) != workers {
		t.Fatalf("requests=%d, want %d", len(requests), workers)
	}
	for index := 1; index < len(requests); index++ {
		if !bytes.Equal(requests[0].Message.RFC822, requests[index].Message.RFC822) ||
			requests[0].Message.MIMEHash != requests[index].Message.MIMEHash ||
			requests[0].Attempt.IdempotencyKey != requests[index].Attempt.IdempotencyKey {
			t.Fatalf("concurrent replay %d drifted", index)
		}
	}
}

func TestDispatchBoundMintsPollLinksForExactRevisionAndOpaqueRecipient(t *testing.T) {
	poll := semanticemail.Node{
		ID: "poll-node", Type: semanticemail.NodePoll, Role: semanticemail.RolePoll,
		Version: semanticemail.NodeVersionV2,
		Content: semanticemail.NodeContent{Poll: &semanticemail.PollContent{
			PollID: "launch-venue",
			Question: semanticemail.RichText{Runs: []semanticemail.InlineRun{{
				Kind: semanticemail.InlineText, Text: "Where should we launch?",
			}}},
			Options: []semanticemail.PollOption{
				{OptionID: "north", Label: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "North hall"}}}},
				{OptionID: "south", Label: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "South hall"}}}},
			},
		}},
		Conditions: []semanticemail.Condition{}, Localizations: map[string]semanticemail.NodeContent{},
		Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
	}

	fixture := newRuntimeFixture(t, poll)
	links := semanticemail.PollOptionLinks{"launch-venue": {
		"north": "https://polls.example.test/api/public/polls/t/launch-venue/north?r=42&t=north-token",
		"south": "https://polls.example.test/api/public/polls/t/launch-venue/south?r=42&t=south-token",
	}}
	minter := &runtimePollMinter{links: links}
	fixture.runtime.Polls = minter

	result, err := fixture.runtime.DispatchBound(t.Context(), fixture.input)
	if err != nil || result.Status != sending.BoundDispatchAccepted {
		t.Fatalf("result = %+v, err = %v", result, err)
	}
	if minter.tenantID != fixture.input.TenantID || minter.campaignID != fixture.input.CampaignID ||
		minter.contentRevisionID != fixture.input.Binding.ContentRevisionID ||
		!minter.issuedAt.Equal(fixture.input.Binding.BoundAt.UTC()) {
		t.Fatalf("link binding = tenant %q campaign %q revision %q", minter.tenantID, minter.campaignID, minter.contentRevisionID)
	}
	if minter.recipientReference != "42" || strings.Contains(minter.recipientReference, "@") {
		t.Fatalf("recipient reference = %q, want opaque campaign recipient ID", minter.recipientReference)
	}
	if len(minter.document.Nodes) != 3 || minter.document.Nodes[2].Content.Poll == nil {
		t.Fatalf("minter did not receive the selected semantic document: %+v", minter.document.Nodes)
	}
	if len(fixture.coordinator.requests) != 1 {
		t.Fatalf("coordinator calls = %d", len(fixture.coordinator.requests))
	}
	parts := decodeRuntimeAlternative(t, fixture.coordinator.requests[0].Message.RFC822)
	for _, link := range links["launch-venue"] {
		if !strings.Contains(parts["text/plain"], link) ||
			!strings.Contains(parts["text/html"], html.EscapeString(link)) {
			t.Fatalf("minted link %q is not identical across the decoded HTML/text projections:\nHTML=%s\nText=%s",
				link, parts["text/html"], parts["text/plain"])
		}
	}

	withoutMinter := newRuntimeFixture(t, poll)
	result, err = withoutMinter.runtime.DispatchBound(t.Context(), withoutMinter.input)
	if err == nil || result.Status != sending.BoundDispatchWithheld || result.Reason != ReasonPollLinksUnavailable {
		t.Fatalf("missing minter result = %+v, err = %v", result, err)
	}
	if len(withoutMinter.coordinator.requests) != 0 {
		t.Fatal("poll send without a link minter crossed the delivery coordinator")
	}
}

func newRuntimeFixture(t *testing.T, extraNodes ...semanticemail.Node) *runtimeFixture {
	t.Helper()
	const sourceMode = campaignartifact.SourceModeSemantic
	now := time.Date(2026, 8, 9, 9, 30, 0, 0, time.UTC)
	tenantID, campaignID, revisionID, planID, runID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	preview := "Your launch details"
	document := semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2, Language: "en", Direction: semanticemail.DirectionAuto,
		Nodes: []semanticemail.Node{
			{
				ID: "heading", Type: semanticemail.NodeHeading, Role: semanticemail.RoleHeading,
				Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Heading: &semanticemail.HeadingContent{
					Level: 1, Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{{Kind: semanticemail.InlineText, Text: "Launch update"}}},
				}},
				Conditions: []semanticemail.Condition{}, Localizations: map[string]semanticemail.NodeContent{},
				Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
			{
				ID: "greeting", Type: semanticemail.NodeParagraph, Role: semanticemail.RoleBody,
				Version: semanticemail.NodeVersionV2,
				Content: semanticemail.NodeContent{Paragraph: &semanticemail.ParagraphContent{
					Text: semanticemail.RichText{Runs: []semanticemail.InlineRun{
						{Kind: semanticemail.InlineText, Text: "Hello "},
						{Kind: semanticemail.InlineSlot, Slot: &semanticemail.SlotReference{ID: "first_name", SemanticClass: semanticemail.SlotName}},
					}},
				}},
				Conditions: []semanticemail.Condition{}, Localizations: map[string]semanticemail.NodeContent{},
				Provenance: semanticemail.Provenance{Source: semanticemail.SourceUser},
			},
		},
	}
	document.Nodes = append(document.Nodes, extraNodes...)
	normalized, diagnostics := semanticemail.NormalizeAndValidateV2(document)
	if diagnostics.HasErrors() {
		t.Fatal(diagnostics)
	}
	nodesRaw := mustCanonicalKind(t, mustJSON(t, normalized.Nodes), "array")
	factContract := mustCanonicalKind(t, []byte(`{}`), "object")
	variants := mustCanonicalKind(t, []byte(`[]`), "array")
	locales := mustCanonicalKind(t, []byte(`["en"]`), "array")
	revision := campaignartifact.Revision{
		ID: revisionID, TenantID: tenantID, CampaignID: campaignID, RevisionNo: 1,
		SourceMode: sourceMode, ContentSchemaVersion: semanticemail.SchemaVersionV2,
		Subject: "Launch update", PreviewText: &preview, SemanticTree: nodesRaw,
		FactContract: factContract, Variants: variants, Locales: locales, CreatedAt: now,
	}
	revision.SourceHash = mustDigest(t, revisionHashIdentity{
		SourceMode: revision.SourceMode, ContentSchemaVersion: revision.ContentSchemaVersion,
		Subject: revision.Subject, PreviewText: revision.PreviewText, SemanticTree: revision.SemanticTree,
		LegacyHTML: revision.LegacyHTML, ReviewedPlainText: revision.ReviewedPlainText,
		FactContract: revision.FactContract, Variants: revision.Variants, Locales: revision.Locales,
	})
	bundle, err := campaignplanbuilder.CompileSyntheticCoverage(campaignplanbuilder.CompileInput{
		Revision: revision, TrackingSettings: []byte(`{}`), PolicyVersion: "policy.test.v1",
		EnvelopeFactoryVersion: "synthetic-envelope.test.v1",
		EnvelopeFactory: func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
			digest := digestBytes([]byte(scenario.ScenarioID))
			return campaigncompiler.Envelope{
				From: mail.Address{Address: "assurance@example.test"}, To: []mail.Address{{Address: "seed@example.test"}},
				Date: now, MessageID: "<synthetic." + digest[:32] + "@example.test>", Boundary: "synthetic-" + digest[:48],
			}, nil
		},
	})
	if err != nil {
		t.Fatalf("compile bundle: %v", err)
	}
	plan := campaignartifact.Plan{
		ID: planID, TenantID: tenantID, CampaignID: campaignID, ContentRevisionID: revisionID,
		PlanNo: 1, RendererVersion: bundle.RendererVersion, CompilerVersion: bundle.CompilerVersion,
		TransformManifest: mustCanonical(t, bundle.TransformManifest), CoverageManifest: mustCanonical(t, bundle.CoverageManifest),
		FixtureSetVersion: bundle.Manifest.FixtureSetVersion, PolicyVersion: bundle.PolicyVersion,
		State: campaignartifact.PlanReady, CreatedAt: now,
	}
	plan.RequestHash = mustDigest(t, planRequestHashIdentity{
		CampaignID: campaignID, ContentRevisionID: revisionID, RendererVersion: plan.RendererVersion,
		CompilerVersion: plan.CompilerVersion, TransformManifest: plan.TransformManifest,
		CoverageManifest: plan.CoverageManifest, FixtureSetVersion: plan.FixtureSetVersion, PolicyVersion: plan.PolicyVersion,
	})
	expires := now.Add(30 * 24 * time.Hour)
	objects := &runtimeObjectReader{values: map[string][]byte{}}
	artifacts := make([]campaignartifact.Artifact, len(bundle.Compiled))
	for index, compiled := range bundle.Compiled {
		input := compiled.Artifact
		input.ExpiresAt = &expires
		rest := "test/" + digestBytes([]byte(compiled.Artifact.ScenarioID)) + ".eml"
		input.MIMEObjectRef = campaignmaterializer.FormatObjectReference(rest)
		input.HTMLObjectRef = campaignmaterializer.FormatObjectReference(rest + ".html")
		input.TextObjectRef = campaignmaterializer.FormatObjectReference(rest + ".txt")
		objects.values[rest] = append([]byte(nil), compiled.RFC822...)
		artifacts[index] = campaignartifact.Artifact{ID: uuid.NewString(), TenantID: tenantID, SendPlanID: planID, ArtifactInput: input, CreatedAt: now}
	}
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].ScenarioID < artifacts[j].ScenarioID })
	identities := make([]artifactHashIdentity, len(artifacts))
	for index, artifact := range artifacts {
		identities[index] = artifactHashIdentity{
			ScenarioID: artifact.ScenarioID, VariantID: artifact.VariantID, Locale: artifact.Locale,
			BranchKey: artifact.BranchKey, FixtureID: artifact.FixtureID, SourceHash: artifact.SourceHash,
			HTMLHash: artifact.HTMLHash, TextHash: artifact.TextHash, StructuredDataHash: artifact.StructuredDataHash,
			MIMEStructureHash: artifact.MIMEStructureHash, OutboundMIMEHash: artifact.OutboundMIMEHash,
			CompilerReceipt: mustCanonical(t, artifact.CompilerReceipt), RepresentationManifest: mustCanonical(t, artifact.RepresentationManifest),
		}
	}
	planHash := mustDigest(t, struct {
		RequestHash string                 `json:"request_hash"`
		Artifacts   []artifactHashIdentity `json:"artifacts"`
	}{plan.RequestHash, identities})
	plan.PlanHash = &planHash
	configuration := campaignassurance.RunConfiguration{
		TenantID: tenantID, CampaignID: campaignID, RunID: runID, Ordinal: 1,
		ID: "deterministic.v1", SourceClass: campaignassurance.SourceDeterministic,
		ConfigurationHash: digestBytes([]byte(`{}`)), Configuration: []byte(`{}`), SnapshottedAt: now,
	}
	runArtifacts := make([]campaignassurance.RunArtifact, len(artifacts))
	targets := make([]campaignassurance.RunTarget, len(artifacts))
	for index, artifact := range artifacts {
		runArtifacts[index] = campaignassurance.RunArtifact{
			TenantID: tenantID, CampaignID: campaignID, RunID: runID, SendPlanID: planID,
			ArtifactID: artifact.ID, Ordinal: index + 1, ScenarioID: artifact.ScenarioID,
			OutboundMIMEHash: artifact.OutboundMIMEHash, MIMEStructureHash: artifact.MIMEStructureHash, SnapshottedAt: now,
		}
		targets[index] = campaignassurance.RunTarget{
			TenantID: tenantID, CampaignID: campaignID, RunID: runID, SendPlanID: planID,
			ArtifactID: artifact.ID, ConfigurationID: configuration.ID, Ordinal: index + 1,
			SourceClass: configuration.SourceClass, ConfigurationHash: configuration.ConfigurationHash,
			OutboundMIMEHash: artifact.OutboundMIMEHash, SnapshottedAt: now,
		}
	}
	artifactSetHash := strings.Repeat("a", 64)
	run := campaignassurance.Run{
		ID: runID, TenantID: tenantID, CampaignID: campaignID, ContentRevisionID: revisionID,
		SendPlanID: planID, State: campaignassurance.StateComplete, Profile: campaignassurance.ProfileFast,
		SourceHash: revision.SourceHash, PlanHash: planHash, ArtifactSetHash: artifactSetHash,
		CoverageManifestHash: digestBytes(plan.CoverageManifest), RendererVersion: plan.RendererVersion,
		ConfigurationManifestHash: strings.Repeat("c", 64), TargetManifestHash: strings.Repeat("b", 64),
		CompilerVersion: plan.CompilerVersion, FixtureSetVersion: plan.FixtureSetVersion,
		PlanPolicyVersion: plan.PolicyVersion, RequiredScenarioCount: len(artifacts),
		RequiredConfigurationCount: 1, RequiredExtractionCount: len(artifacts),
		TerminalExtractionCount: len(artifacts), SuccessfulExtractionCount: len(artifacts),
		GateDecision: campaignassurance.GatePass, AttemptCount: 1, CreatedAt: now,
	}
	artifactReader := &runtimeArtifactReader{revision: revision, plan: plan, artifacts: artifacts}
	assuranceReader := &runtimeAssuranceReader{manifest: campaignassurance.ClaimedRun{Run: run, Artifacts: runArtifacts, Configurations: []campaignassurance.RunConfiguration{configuration}, Targets: targets}}
	recipients := &runtimeRecipientResolver{values: RecipientValues{Locale: "en", Slots: map[semanticemail.SlotID]string{"first_name": "Asha"}}}
	coordinator := &runtimeCoordinator{}
	input := sending.BoundDispatchInput{
		TenantID: tenantID, CampaignID: campaignID, CampaignRecipientID: 42,
		Recipient: "asha@example.net", Binding: sending.AssuranceBinding{
			ContentRevisionID: revisionID, SendPlanID: planID, RunID: runID, RunAttempt: 1,
			ArtifactSetHash: artifactSetHash, SourceHash: revision.SourceHash, PlanHash: planHash,
			GateDecision: "pass", BoundAt: &now,
		},
		FromName: "Launch Team", FromEmail: "news@example.com", ReplyTo: "help@example.com",
		Headers: map[string]string{
			"From": `"Launch Team" <news@example.com>`, "Reply-To": "help@example.com",
			"List-Unsubscribe":      "<https://example.com/u/token>, <mailto:unsubscribe@example.com>",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			"X-Postwave-Tenant":     tenantID, "X-Postwave-Campaign": campaignID,
		},
	}
	gate := &runtimeGate{receipt: campaignassurancegate.Receipt{
		PolicyVersion: campaignassurancegate.PolicyVersion, TenantID: tenantID,
		CampaignID: campaignID, RunID: runID, ContentRevisionID: revisionID,
		SendPlanID: planID, SourceHash: revision.SourceHash, PlanHash: planHash,
		ArtifactSetHash: artifactSetHash, RunAttempt: 1, Decision: "pass", AuthorizedAt: now,
	}}
	replyCorrelation, err := replycorrelation.NewService("reply.example.test", replycorrelation.DefaultTTL, []replycorrelation.Key{{
		ID: "k1", Secret: []byte(strings.Repeat("s", 32)),
		NotBefore: now.Add(-24 * time.Hour), NotAfter: now.Add(365 * 24 * time.Hour),
	}}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	runtime := &Runtime{Artifacts: artifactReader, Assurance: assuranceReader, Gate: gate, Objects: objects, Recipients: recipients, ReplyCorrelation: replyCorrelation, Delivery: coordinator, Now: func() time.Time { return now }}
	return &runtimeFixture{runtime: runtime, input: input, artifacts: artifactReader, assurance: assuranceReader, gate: gate, objects: objects, recipients: recipients, coordinator: coordinator}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := jsonMarshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func mustDigest(t *testing.T, value any) string {
	t.Helper()
	valueDigest, err := digestJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	return valueDigest
}
func mustCanonical(t *testing.T, raw []byte) []byte {
	return mustCanonicalKind(t, raw, "object")
}
func mustCanonicalKind(t *testing.T, raw []byte, kind string) []byte {
	t.Helper()
	value, err := canonicalJSON(raw, kind)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func mustObjectRest(t *testing.T, reference string) string {
	t.Helper()
	rest, err := campaignmaterializer.ParseObjectReference(reference)
	if err != nil {
		t.Fatal(err)
	}
	return rest
}

func decodeRuntimeAlternative(t *testing.T, raw []byte) map[string]string {
	t.Helper()
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	mediaType, parameters, err := mime.ParseMediaType(message.Header.Get("Content-Type"))
	if err != nil {
		t.Fatal(err)
	}
	if mediaType != "multipart/alternative" {
		t.Fatalf("Content-Type = %q, want multipart/alternative", mediaType)
	}
	reader := multipart.NewReader(message.Body, parameters["boundary"])
	parts := make(map[string]string, 2)
	for {
		part, nextErr := reader.NextRawPart()
		if errors.Is(nextErr, io.EOF) {
			return parts
		}
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		partType, _, parseErr := mime.ParseMediaType(part.Header.Get("Content-Type"))
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		decoded, readErr := io.ReadAll(quotedprintable.NewReader(part))
		if readErr != nil {
			t.Fatal(readErr)
		}
		parts[partType] = string(decoded)
	}
}

func cloneSlotsForTest(input map[semanticemail.SlotID]string) map[semanticemail.SlotID]string {
	out := make(map[semanticemail.SlotID]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

// Tiny wrappers keep this test's imports focused while preserving errors.Is.
func jsonMarshal(value any) ([]byte, error) { return json.Marshal(value) }
func errorsIs(err, target error) bool       { return errors.Is(err, target) }
func errorsNew(message string) error        { return errors.New(message) }
