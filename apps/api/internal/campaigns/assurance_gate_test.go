// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
)

type assuranceGateProbe struct {
	request campaignassurancegate.Request
	receipt campaignassurancegate.Receipt
	err     error
	calls   int
}

type stagedAssuranceGateProbe struct {
	*assuranceGateProbe
	mode campaignassurancegate.RolloutMode
}

func (p *stagedAssuranceGateProbe) RolloutMode() campaignassurancegate.RolloutMode {
	return p.mode
}

func (p *assuranceGateProbe) Authorize(_ context.Context, request campaignassurancegate.Request) (campaignassurancegate.Receipt, error) {
	p.calls++
	p.request = request
	return p.receipt, p.err
}

func assuranceRevisionFixture() *campaignartifact.Revision {
	return &campaignartifact.Revision{
		ID: uuid.NewString(), TenantID: uuid.NewString(), CampaignID: uuid.NewString(),
		SourceHash: strings.Repeat("a", 64),
	}
}

func TestAuthorizeCampaignRevisionBindsExactFrozenIdentity(t *testing.T) {
	revision := assuranceRevisionFixture()
	probe := &assuranceGateProbe{receipt: campaignassurancegate.Receipt{
		RunID: uuid.NewString(), SendPlanID: uuid.NewString(), Decision: "pass",
	}}
	receipt, queueErr := (&Deps{AssuranceGate: probe, AssuranceGateEnabled: true}).authorizeCampaignRevision(
		context.Background(), revision.TenantID, revision, false,
	)
	if queueErr != nil {
		t.Fatalf("authorize revision: %v", queueErr)
	}
	if receipt.RunID != probe.receipt.RunID || probe.calls != 1 ||
		probe.request.TenantID != revision.TenantID ||
		probe.request.CampaignID != revision.CampaignID ||
		probe.request.ContentRevisionID != revision.ID ||
		probe.request.SourceHash != revision.SourceHash {
		t.Fatalf("receipt=%+v request=%+v calls=%d", receipt, probe.request, probe.calls)
	}
}

func TestAuthorizeCampaignRevisionFailsClosedAndMapsDenials(t *testing.T) {
	revision := assuranceRevisionFixture()
	_, queueErr := (&Deps{AssuranceGateEnabled: true}).authorizeCampaignRevision(context.Background(), revision.TenantID, revision, false)
	if queueErr == nil || queueErr.Status != http.StatusServiceUnavailable || queueErr.Code != "campaign_assurance_unavailable" {
		t.Fatalf("nil gate error = %+v", queueErr)
	}
	tests := []struct {
		err    error
		status int
		code   string
	}{
		{campaignassurancegate.ErrNotAssured, http.StatusConflict, "campaign_assurance_required"},
		{campaignassurancegate.ErrPending, http.StatusConflict, "campaign_assurance_pending"},
		{campaignassurancegate.ErrStale, http.StatusConflict, "campaign_assurance_stale"},
		{campaignassurancegate.ErrBlocked, http.StatusUnprocessableEntity, "campaign_assurance_blocked"},
		{campaignassurancegate.ErrUnavailable, http.StatusServiceUnavailable, "campaign_assurance_unavailable"},
		{campaignassurancegate.ErrIntegrityMismatch, http.StatusServiceUnavailable, "campaign_assurance_unavailable"},
	}
	for _, test := range tests {
		probe := &assuranceGateProbe{err: test.err}
		_, got := (&Deps{AssuranceGate: probe, AssuranceGateEnabled: true}).authorizeCampaignRevision(
			context.Background(), revision.TenantID, revision, false,
		)
		if got == nil || got.Status != test.status || got.Code != test.code {
			t.Fatalf("%v => %+v, want status=%d code=%q", test.err, got, test.status, test.code)
		}
	}
	probe := &assuranceGateProbe{err: errors.New("database down")}
	_, got := (&Deps{AssuranceGate: probe, AssuranceGateEnabled: true}).authorizeCampaignRevision(
		context.Background(), revision.TenantID, revision, false,
	)
	if got == nil || got.Status != http.StatusInternalServerError || got.Err == nil {
		t.Fatalf("unexpected infrastructure mapping: %+v", got)
	}
}

func TestAuthorizeCampaignRevisionSkipsOnlyNonDeliveringOrLegacyPaths(t *testing.T) {
	probe := &assuranceGateProbe{err: errors.New("must not be called")}
	revision := assuranceRevisionFixture()
	if _, err := (&Deps{AssuranceGate: probe, AssuranceGateEnabled: true}).authorizeCampaignRevision(
		context.Background(), revision.TenantID, revision, true,
	); err != nil {
		t.Fatalf("sandbox authorization: %v", err)
	}
	// A disabled staged rollout never invokes the gate.
	if _, err := (&Deps{AssuranceGate: probe}).authorizeCampaignRevision(
		context.Background(), revision.TenantID, nil, false,
	); err != nil {
		t.Fatalf("legacy authorization: %v", err)
	}
	if probe.calls != 0 {
		t.Fatalf("gate called %d times", probe.calls)
	}
}

func TestAuthorizeCampaignRevisionUsesStagedRolloutAsPolicyAuthority(t *testing.T) {
	revision := assuranceRevisionFixture()
	for _, mode := range []campaignassurancegate.RolloutMode{
		campaignassurancegate.RolloutShadow,
		campaignassurancegate.RolloutWarn,
		campaignassurancegate.RolloutBlock,
	} {
		t.Run(string(mode), func(t *testing.T) {
			probe := &assuranceGateProbe{}
			staged := &stagedAssuranceGateProbe{assuranceGateProbe: probe, mode: mode}
			deps := &Deps{AssuranceGate: staged}
			if got := deps.campaignAssuranceRolloutMode(); got != mode {
				t.Fatalf("mode=%q, want %q", got, mode)
			}
			if _, queueErr := deps.authorizeCampaignRevision(t.Context(), revision.TenantID, revision, false); queueErr != nil {
				t.Fatalf("authorize: %v", queueErr)
			}
			if probe.calls != 1 {
				t.Fatalf("gate calls=%d, want 1", probe.calls)
			}
		})
	}
}

func TestNormalizeQueueAssuranceBindingIsClosedAndCanonical(t *testing.T) {
	tenantID, campaignID := uuid.NewString(), uuid.NewString()
	receipt := &campaignassurancegate.Receipt{
		PolicyVersion: campaignassurancegate.PolicyVersion,
		TenantID:      tenantID, CampaignID: campaignID,
		ContentRevisionID: uuid.NewString(), SendPlanID: uuid.NewString(),
		RunID: uuid.NewString(), RunAttempt: 2,
		ArtifactSetHash: strings.Repeat("b", 64), SourceHash: strings.Repeat("c", 64),
		PlanHash: strings.Repeat("d", 64), Decision: "pass", AuthorizedAt: time.Now().UTC(),
	}
	binding, err := normalizeQueueAssuranceBinding(tenantID, campaignID, receipt)
	if err != nil || binding.RunID != receipt.RunID || binding.BoundAt == nil || len(binding.OverrideIDs) != 0 {
		t.Fatalf("binding=%+v err=%v", binding, err)
	}
	foreign := *receipt
	foreign.TenantID = uuid.NewString()
	if _, err := normalizeQueueAssuranceBinding(tenantID, campaignID, &foreign); err == nil {
		t.Fatal("foreign tenant receipt accepted")
	}
	overridden := *receipt
	overridden.Decision = "overridden"
	left, right := uuid.NewString(), uuid.NewString()
	if right < left {
		left, right = right, left
	}
	overridden.OverrideIDs = []string{left, right}
	if _, err := normalizeQueueAssuranceBinding(tenantID, campaignID, &overridden); err != nil {
		t.Fatalf("valid overridden receipt: %v", err)
	}
	overridden.OverrideIDs = []string{right, left}
	if _, err := normalizeQueueAssuranceBinding(tenantID, campaignID, &overridden); err == nil {
		t.Fatal("unsorted override receipt accepted")
	}
	if shadow, err := normalizeQueueAssuranceBinding(tenantID, campaignID, nil); err != nil || shadow.BoundAt != nil || shadow.OverrideIDs == nil {
		t.Fatalf("shadow binding=%+v err=%v", shadow, err)
	}
}
