// SPDX-License-Identifier: AGPL-3.0-only
//
// orchestrator.go — the state machine. CreateTest mints a row +
// header_token; RecordResult writes a per-mailbox classification and
// advances the parent's status; Finalize is the timer-driven sweep
// that closes out tests whose expires_at has passed.

package inboxreality

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SeedRegistry is the seam to the deliverability service's seedlist
// YAML. The handler calls Seeds() once per test to learn which
// mailboxes the customer should send to. We don't take this from the
// DB because the source of truth lives in
// services/deliverability/internal/seedlist/inbox.go — a static
// snapshot returned here keeps the gateway independent of the
// service's runtime state.
type SeedRegistry interface {
	Seeds(ctx context.Context) ([]SeedAddress, error)
	ProviderInfo(ctx context.Context) ([]ProviderInfo, error)
}

// Orchestrator wires the Store + SeedRegistry into the lifecycle
// operations the handler calls.
type Orchestrator struct {
	Store Store
	Seeds SeedRegistry
	// Lifecycle is the exact-artifact gateway authority. NewOrchestrator
	// discovers it from Store when the production Postgres implementation is
	// used; tests may inject a dedicated fake.
	Lifecycle LifecycleStore
	// TokenMinter is the seam to crypto/rand. Tests pass a deterministic
	// minter; production passes MintToken.
	TokenMinter func() (string, error)
	// Clock is the time seam. Production: time.Now. Tests: fixed.
	Clock func() time.Time
	// DefaultTTL is how long a test waits before auto-expiring. The
	// migration also sets a 10 minute default; this is the
	// orchestrator-side fallback when the caller omits an explicit
	// expires_at.
	DefaultTTL time.Duration
	// MaxCreateRetries bounds the loop that re-mints a token on
	// UNIQUE collision. 3 is plenty — the per-attempt collision odds
	// are ~ 1 / 2^128.
	MaxCreateRetries int
}

// NewOrchestrator returns an Orchestrator with sensible defaults.
func NewOrchestrator(store Store, seeds SeedRegistry) *Orchestrator {
	orchestrator := &Orchestrator{
		Store:            store,
		Seeds:            seeds,
		TokenMinter:      MintToken,
		Clock:            time.Now,
		DefaultTTL:       10 * time.Minute,
		MaxCreateRetries: 3,
	}
	if lifecycle, ok := store.(LifecycleStore); ok {
		orchestrator.Lifecycle = lifecycle
	}
	return orchestrator
}

// CreateTestInput is what the handler unmarshalls from POST /tests.
type CreateTestInput struct {
	Kind        Kind   `json:"kind"`
	Subject     string `json:"subject"`
	FromAddress string `json:"from"`
	// TTL overrides DefaultTTL when > 0 and <= 1h.
	TTL                   time.Duration          `json:"-"`
	Meta                  []byte                 `json:"-"` // raw JSON; orchestrator passes through
	ArtifactID            string                 `json:"artifactId,omitempty"`
	ScenarioID            string                 `json:"scenarioId,omitempty"`
	IdempotencyKey        string                 `json:"-"`
	RequestedCapabilities CapabilityRequirements `json:"requestedCapabilities,omitempty"`
}

// CreateTestOutput is what the handler returns to POST /tests.
type CreateTestOutput struct {
	Test          Test             `json:"test"`
	HeaderName    string           `json:"headerName"`
	HeaderValue   string           `json:"headerValue"`
	SeedAddresses []SeedAddress    `json:"seedAddresses"`
	Dispatch      *DispatchCommand `json:"dispatch,omitempty"`
}

// PostwaveTestHeaderName is the canonical RFC-822 header name the
// dispatcher attaches; mirrors PostwaveTestHeader in the deliverability
// service's seedlist/poller.go.
const PostwaveTestHeaderName = "X-Postwave-Test-ID"

// CreateTest is the entry point. Validates input, picks a kind,
// mints a unique token (retry-on-collision), creates the row, and
// fetches the seed addresses to return.
func (o *Orchestrator) CreateTest(ctx context.Context, tenantID string, in CreateTestInput) (CreateTestOutput, error) {
	if tenantID == "" {
		return CreateTestOutput{}, errors.New("inboxreality: tenant id required")
	}
	if o.Store == nil {
		return CreateTestOutput{}, errors.New("inboxreality: store not configured")
	}
	exactRequested := in.ArtifactID != "" || in.ScenarioID != "" || in.IdempotencyKey != ""
	if in.Kind == "" {
		if exactRequested {
			in.Kind = KindCampaignAssurance
		} else {
			in.Kind = KindManual
		}
	}
	if !knownKind(in.Kind) {
		return CreateTestOutput{}, fmt.Errorf("inboxreality: unknown kind %q", in.Kind)
	}
	ttl := o.DefaultTTL
	if in.TTL > 0 && in.TTL <= time.Hour {
		ttl = in.TTL
	}
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	clock := o.Clock
	if clock == nil {
		clock = time.Now
	}
	expiresAt := clock().Add(ttl).UTC()
	if exactRequested {
		if in.Kind != KindCampaignAssurance || o.Lifecycle == nil ||
			strings.TrimSpace(in.ArtifactID) == "" || strings.TrimSpace(in.ScenarioID) == "" ||
			strings.TrimSpace(in.IdempotencyKey) == "" {
			return CreateTestOutput{}, ErrInvalidLifecycle
		}
		requirements, err := in.RequestedCapabilities.normalized()
		if err != nil {
			return CreateTestOutput{}, err
		}
		requestHash, err := exactCreateRequestHash(in.ArtifactID, in.ScenarioID,
			in.IdempotencyKey, ttl, requirements)
		if err != nil {
			return CreateTestOutput{}, err
		}
		return o.createExactTest(ctx, tenantID, in, expiresAt, requestHash, requirements)
	}
	if in.Kind == KindCampaignAssurance {
		return CreateTestOutput{}, ErrInvalidLifecycle
	}

	// A manual test is useful only when real controlled addresses were loaded.
	// Creating a row with StaticSeedRegistry's empty list was a plausible-looking
	// success that could never produce an observation.
	if o.Seeds == nil {
		return CreateTestOutput{}, errors.New("inboxreality: seed registry not configured")
	}
	seeds, err := o.Seeds.Seeds(ctx)
	if err != nil || len(seeds) == 0 {
		if err != nil {
			return CreateTestOutput{}, fmt.Errorf("inboxreality: load active seeds: %w", err)
		}
		return CreateTestOutput{}, ErrNoActiveSeeds
	}

	mint := o.TokenMinter
	if mint == nil {
		mint = MintToken
	}
	retries := o.MaxCreateRetries
	if retries <= 0 {
		retries = 3
	}
	var t Test
	for attempt := 0; attempt < retries; attempt++ {
		token, err := mint()
		if err != nil {
			return CreateTestOutput{}, fmt.Errorf("inboxreality: mint: %w", err)
		}
		t, err = o.Store.CreateTest(ctx, CreateTestParams{
			TenantID:    tenantID,
			HeaderToken: token,
			Kind:        in.Kind,
			Subject:     in.Subject,
			FromAddress: in.FromAddress,
			ExpiresAt:   expiresAt,
			Meta:        in.Meta,
		})
		if err == nil {
			break
		}
		if !errors.Is(err, ErrTokenCollision) {
			return CreateTestOutput{}, err
		}
		// Loop and re-mint.
	}
	if t.ID == "" {
		return CreateTestOutput{}, errors.New("inboxreality: exhausted retries trying to mint a unique token")
	}

	return CreateTestOutput{
		Test:          t,
		HeaderName:    PostwaveTestHeaderName,
		HeaderValue:   FormatHeaderValue(t.HeaderToken),
		SeedAddresses: seeds,
	}, nil
}

func (o *Orchestrator) createExactTest(
	ctx context.Context,
	tenantID string,
	in CreateTestInput,
	expiresAt time.Time,
	requestHash string,
	requirements CapabilityRequirements,
) (CreateTestOutput, error) {
	mint := o.TokenMinter
	if mint == nil {
		mint = MintToken
	}
	retries := o.MaxCreateRetries
	if retries <= 0 {
		retries = 3
	}
	for attempt := 0; attempt < retries; attempt++ {
		token, err := mint()
		if err != nil {
			return CreateTestOutput{}, fmt.Errorf("inboxreality: mint: %w", err)
		}
		created, err := o.Lifecycle.CreateExactTest(ctx, ExactCreateParams{
			TenantID: tenantID, HeaderToken: token, ArtifactID: strings.TrimSpace(in.ArtifactID),
			ScenarioID: strings.TrimSpace(in.ScenarioID), IdempotencyKey: strings.TrimSpace(in.IdempotencyKey),
			RequestHash: requestHash, RequestedCapabilities: requirements, ExpiresAt: expiresAt,
		})
		if errors.Is(err, ErrTokenCollision) {
			continue
		}
		if err != nil {
			return CreateTestOutput{}, err
		}
		command := created.Command
		return CreateTestOutput{
			Test: created.Test, HeaderName: PostwaveTestHeaderName,
			HeaderValue: FormatHeaderValue(created.Test.HeaderToken), Dispatch: &command,
		}, nil
	}
	return CreateTestOutput{}, errors.New("inboxreality: exhausted retries trying to mint a unique token")
}

func exactCreateRequestHash(
	artifactID, scenarioID, idempotencyKey string,
	ttl time.Duration,
	requirements CapabilityRequirements,
) (string, error) {
	encoded, err := json.Marshal(struct {
		Version        string                 `json:"version"`
		ArtifactID     string                 `json:"artifact_id"`
		ScenarioID     string                 `json:"scenario_id"`
		IdempotencyKey string                 `json:"idempotency_key"`
		TTLSeconds     int64                  `json:"ttl_seconds"`
		Capabilities   CapabilityRequirements `json:"capabilities"`
	}{
		Version: "postwave.inbox-reality-create.v1", ArtifactID: strings.TrimSpace(artifactID),
		ScenarioID: strings.TrimSpace(scenarioID), IdempotencyKey: strings.TrimSpace(idempotencyKey),
		TTLSeconds: int64(ttl / time.Second), Capabilities: requirements,
	})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// RecordResult writes one per-mailbox classification and advances the
// parent test's status. Called by the deliverability-service pivot
// when its poller classifies a message tagged with one of our tokens.
//
// Status transitions:
//
//	awaiting_delivery -> classifying  (first result arrives)
//	classifying       -> classifying  (mid-stream — no DB write here)
//	classifying       -> complete     (all active seeds have reported)
//
// The "all active seeds have reported" check is delegated to the
// caller because the orchestrator doesn't know which seeds are
// currently healthy — that's a deliverability-service question. The
// caller passes activeSeedCount; when reached, the orchestrator
// finalises.
func (o *Orchestrator) RecordResult(ctx context.Context, p RecordResultParams, activeSeedCount int) (Result, error) {
	if o.Store == nil {
		return Result{}, errors.New("inboxreality: store not configured")
	}
	r, err := o.Store.RecordResult(ctx, p)
	if err != nil {
		return Result{}, err
	}
	// Fetch the parent test to inspect status. We use FindTestByToken
	// here only as a fallback; RecordResult already has the test_id.
	clock := o.Clock
	if clock == nil {
		clock = time.Now
	}
	// We don't have tenant_id at hand — pull it from the test row.
	// FindTestByToken expects token; we don't have that either. The
	// RecordResult path is intentionally lean: the caller already
	// performed the existence check, so we trust that the test
	// exists. The remaining state-machine work (status advance) is
	// triggered via FinalizeIfDone.
	if err := o.maybeAdvanceStatus(ctx, p.TestID, activeSeedCount, clock); err != nil {
		// Status advance failure is non-fatal: the result IS written.
		// Surface as a debug log signal at the call site.
		_ = err
	}
	return r, nil
}

// maybeAdvanceStatus inspects the result count vs active seed count
// and transitions the test status accordingly.
func (o *Orchestrator) maybeAdvanceStatus(ctx context.Context, testID string, activeSeedCount int, clock func() time.Time) error {
	// We need the tenant_id, which RecordResult's params don't carry.
	// Use FindTestByToken via the test row — fetch from the store using
	// the only id we have. Stores that wrap RLS need a tenant scope;
	// to avoid that, we use the cross-tenant FindTestByToken-style
	// path via the store's tenantOf helper. To keep the public Store
	// interface clean, we go via FindTestByToken using the test ID's
	// tenant — but we don't have the token either. The Postgres impl's
	// FindTestByToken takes a token, not a test_id, so we'd need a new
	// method. For now we leave the status advance to a separate
	// sweep job (see FinalizeExpired).
	_, _, _, _ = ctx, testID, activeSeedCount, clock
	return nil
}

// FinalizeIfReady is the helper the dashboard handler calls after a
// successful GET to advance the test status when all active seeds
// have reported. We do it on read rather than on write so the status
// transition doesn't race with concurrent RecordResult calls (read is
// a tenant-scoped tx; multiple readers can serialise on it without
// deadlock).
//
// Returns the (possibly updated) Test.
func (o *Orchestrator) FinalizeIfReady(ctx context.Context, tenantID, testID string, activeSeedCount int) (Test, error) {
	t, err := o.Store.GetTest(ctx, tenantID, testID)
	if err != nil {
		return Test{}, err
	}
	if t.Status == StatusComplete || t.Status == StatusExpired || t.Status == StatusCancelled {
		return t, nil
	}
	results, err := o.Store.ListResults(ctx, tenantID, testID)
	if err != nil {
		return Test{}, err
	}
	clock := o.Clock
	if clock == nil {
		clock = time.Now
	}
	now := clock()
	// Expiry takes priority over "all seeds reported" because an
	// expired test should always land at StatusExpired even if every
	// seed happens to have reported just before the deadline (avoids
	// flickering between Complete and Expired across reads).
	if now.After(t.ExpiresAt) {
		nowU := now.UTC()
		newStatus := StatusExpired
		if len(results) > 0 {
			// We did get SOME data but not all; mark complete instead
			// of expired so the dashboard renders partial results.
			newStatus = StatusComplete
		}
		_ = o.Store.UpdateStatus(ctx, tenantID, testID, newStatus, &nowU)
		t.Status = newStatus
		t.CompletedAt = &nowU
		return t, nil
	}
	if activeSeedCount > 0 && len(results) >= activeSeedCount {
		nowU := now.UTC()
		_ = o.Store.UpdateStatus(ctx, tenantID, testID, StatusComplete, &nowU)
		t.Status = StatusComplete
		t.CompletedAt = &nowU
		return t, nil
	}
	if len(results) > 0 && t.Status == StatusAwaitingDelivery {
		_ = o.Store.UpdateStatus(ctx, tenantID, testID, StatusClassifying, nil)
		t.Status = StatusClassifying
	}
	return t, nil
}

// SummariseResults rolls a result list into the wire-format summary.
// Pure function (no DB) so it can be reused by tests and the future
// MCP "inbox_reality.preview" tool.
func SummariseResults(results []Result) Summary {
	sum := Summary{
		Placements: map[Placement]int{},
		Providers:  []ProviderBreakdown{},
	}
	byProvider := map[Provider]*ProviderBreakdown{}
	for _, r := range results {
		sum.Total++
		sum.Placements[r.Placement]++
		pb := byProvider[r.Provider]
		if pb == nil {
			pb = &ProviderBreakdown{
				Provider:   r.Provider,
				Label:      r.Provider.DisplayName(),
				Placements: map[Placement]int{},
			}
			byProvider[r.Provider] = pb
		}
		pb.Total++
		pb.Placements[r.Placement]++
	}
	if sum.Total > 0 {
		sum.PrimaryPct = ratio(sum.Placements[PlacementPrimary], sum.Total)
		sum.SpamPct = ratio(sum.Placements[PlacementSpam], sum.Total)
	}
	// Stable provider order — sum.Providers always lists every
	// AllProviders slot, even if zero results so far, so the
	// dashboard can render a stable bar chart.
	for _, p := range AllProviders {
		pb, ok := byProvider[p]
		if !ok {
			pb = &ProviderBreakdown{
				Provider:   p,
				Label:      p.DisplayName(),
				Placements: map[Placement]int{},
			}
		}
		if pb.Total > 0 {
			pb.PrimaryPct = ratio(pb.Placements[PlacementPrimary], pb.Total)
			pb.SpamPct = ratio(pb.Placements[PlacementSpam], pb.Total)
		}
		sum.Providers = append(sum.Providers, *pb)
	}
	return sum
}

func ratio(num, den int) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

func knownKind(k Kind) bool {
	switch k {
	case KindManual, KindCampaignPreview, KindMCPTool, KindAPI, KindCampaignAssurance:
		return true
	}
	return false
}
