// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/campaignplanbuilder"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	productionPlanPolicyVersion = "postwave.campaign-plan-policy.v1"
	productionEnvelopeFactory   = "postwave.assurance-synthetic-envelope.v1"
	defaultSyntheticArtifactTTL = 30 * 24 * time.Hour
	minimumSyntheticArtifactTTL = 24 * time.Hour
	maximumSyntheticArtifactTTL = 90 * 24 * time.Hour
)

var (
	ErrSnapshotUnsupported    = errors.New("campaign assurance api: snapshot unsupported")
	ErrPreparationUnavailable = errors.New("campaign assurance api: snapshot preparation unavailable")
)

type PrepareSnapshotCommand struct {
	TenantID   string
	CampaignID string
	// Empty means freeze the current mutable draft. A supplied value selects
	// that exact existing immutable revision and never re-reads draft content.
	ContentRevisionID string
	RequestID         string
	ActorID           string
}

type PreparedSnapshot struct {
	ContentRevisionID string
	SendPlanID        string
}

// SnapshotArtifactStore is deliberately narrower than campaignartifact.Repo.
// It exposes only immutable source/plan construction and finalization.
type SnapshotArtifactStore interface {
	FreezeCurrent(context.Context, string, string, string) (*campaignartifact.Revision, error)
	GetRevision(context.Context, string, string, string) (*campaignartifact.Revision, error)
	CreatePlan(context.Context, string, campaignartifact.PlanInput) (*campaignartifact.Plan, error)
	FinalizePlan(context.Context, string, string, []campaignartifact.ArtifactInput) (*campaignartifact.Plan, error)
}

type CurrentSnapshotPreparer struct {
	Artifacts        SnapshotArtifactStore
	Objects          campaignmaterializer.ObjectStore
	StructuredPolicy semanticemail.StructuredPolicy
	PolicyVersion    string
	ArtifactTTL      time.Duration
}

func NewCurrentSnapshotPreparer(
	artifacts SnapshotArtifactStore,
	objects campaignmaterializer.ObjectStore,
) *CurrentSnapshotPreparer {
	return &CurrentSnapshotPreparer{
		Artifacts: artifacts, Objects: objects,
		PolicyVersion: productionPlanPolicyVersion,
		ArtifactTTL:   defaultSyntheticArtifactTTL,
	}
}

// PrepareAssuranceSnapshot owns every compiler and materialization input that
// could change the artifact set. The request UUID is shared by the plan and
// run repositories, giving a transport retry one convergent immutable result.
func (p *CurrentSnapshotPreparer) PrepareAssuranceSnapshot(
	ctx context.Context,
	command PrepareSnapshotCommand,
) (PreparedSnapshot, error) {
	if p == nil || p.Artifacts == nil || p.Objects == nil {
		return PreparedSnapshot{}, ErrPreparationUnavailable
	}
	var err error
	for name, value := range map[string]*string{
		"tenant_id": &command.TenantID, "campaign_id": &command.CampaignID,
		"request_id": &command.RequestID, "actor_id": &command.ActorID,
	} {
		*value, err = canonicalPreparationUUID(*value)
		if err != nil {
			return PreparedSnapshot{}, fmt.Errorf("%w: invalid %s", campaignartifact.ErrInvalidInput, name)
		}
	}
	if strings.TrimSpace(command.ContentRevisionID) != "" {
		command.ContentRevisionID, err = canonicalPreparationUUID(command.ContentRevisionID)
		if err != nil {
			return PreparedSnapshot{}, fmt.Errorf("%w: invalid content_revision_id", campaignartifact.ErrInvalidInput)
		}
	}

	revision, err := p.resolveRevision(ctx, command)
	if err != nil {
		if errors.Is(err, campaignartifact.ErrInvalidInput) ||
			errors.Is(err, campaignartifact.ErrSourceIncomplete) {
			return PreparedSnapshot{}, fmt.Errorf("%w: %v", ErrSnapshotUnsupported, err)
		}
		return PreparedSnapshot{}, err
	}
	if revision == nil || revision.TenantID != command.TenantID ||
		revision.CampaignID != command.CampaignID ||
		(command.ContentRevisionID != "" && revision.ID != command.ContentRevisionID) {
		return PreparedSnapshot{}, ErrPreparationUnavailable
	}

	policyVersion := strings.TrimSpace(p.PolicyVersion)
	if policyVersion == "" {
		policyVersion = productionPlanPolicyVersion
	}
	bundle, err := campaignplanbuilder.CompileSyntheticCoverage(campaignplanbuilder.CompileInput{
		Revision:               *revision,
		TrackingSettings:       append([]byte(nil), revision.TrackingSettings...),
		StructuredPolicy:       p.StructuredPolicy,
		PolicyVersion:          policyVersion,
		EnvelopeFactoryVersion: productionEnvelopeFactory,
		EnvelopeFactory:        syntheticEnvelopeFactory(*revision),
	})
	if err != nil {
		return PreparedSnapshot{}, fmt.Errorf("%w: %v", ErrSnapshotUnsupported, err)
	}
	planInput, err := bundle.PlanInput(command.RequestID, command.ActorID)
	if err != nil {
		return PreparedSnapshot{}, fmt.Errorf("%w: %v", ErrSnapshotUnsupported, err)
	}
	plan, err := p.Artifacts.CreatePlan(ctx, command.TenantID, planInput)
	if err != nil {
		return PreparedSnapshot{}, err
	}
	if plan == nil || plan.TenantID != command.TenantID ||
		plan.CampaignID != command.CampaignID || plan.ContentRevisionID != revision.ID {
		return PreparedSnapshot{}, ErrPreparationUnavailable
	}
	if plan.State == campaignartifact.PlanReady || plan.State == campaignartifact.PlanCertified {
		return PreparedSnapshot{ContentRevisionID: revision.ID, SendPlanID: plan.ID}, nil
	}
	if plan.State != campaignartifact.PlanPreparing {
		return PreparedSnapshot{}, campaignartifact.ErrPlanNotPreparing
	}

	ttl := p.ArtifactTTL
	if ttl == 0 {
		ttl = defaultSyntheticArtifactTTL
	}
	if ttl < minimumSyntheticArtifactTTL || ttl > maximumSyntheticArtifactTTL {
		return PreparedSnapshot{}, ErrPreparationUnavailable
	}
	// Plan.CreatedAt is durable and therefore keeps expires_at identical on a
	// retry. time.Now would turn a replay into a different artifact input.
	expiresAt := plan.CreatedAt.UTC().Add(ttl)
	builder := campaignplanbuilder.Builder{Materializer: &campaignmaterializer.Materializer{
		Objects: p.Objects, Finalizer: p.Artifacts,
	}}
	result, err := builder.FinalizeSyntheticPlan(ctx, campaignplanbuilder.FinalizeInput{
		TenantID: command.TenantID, Plan: *plan, ExpiresAt: expiresAt, Bundle: bundle,
	})
	if err != nil {
		return PreparedSnapshot{}, fmt.Errorf("%w: %v", ErrPreparationUnavailable, err)
	}
	if result.Materialized.Plan.ID != plan.ID ||
		(result.Materialized.Plan.State != campaignartifact.PlanReady &&
			result.Materialized.Plan.State != campaignartifact.PlanCertified) {
		return PreparedSnapshot{}, ErrPreparationUnavailable
	}
	return PreparedSnapshot{ContentRevisionID: revision.ID, SendPlanID: plan.ID}, nil
}

func (p *CurrentSnapshotPreparer) resolveRevision(
	ctx context.Context,
	command PrepareSnapshotCommand,
) (*campaignartifact.Revision, error) {
	if command.ContentRevisionID == "" {
		return p.Artifacts.FreezeCurrent(ctx, command.TenantID, command.CampaignID, command.ActorID)
	}
	return p.Artifacts.GetRevision(ctx, command.TenantID, command.CampaignID, command.ContentRevisionID)
}

func canonicalPreparationUUID(value string) (string, error) {
	parsed, err := uuid.Parse(strings.TrimSpace(value))
	if err != nil || parsed.String() != strings.TrimSpace(value) {
		return "", errors.New("identity must be a canonical UUID")
	}
	return parsed.String(), nil
}

func syntheticEnvelopeFactory(revision campaignartifact.Revision) campaignplanbuilder.EnvelopeFactory {
	return func(scenario campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error) {
		digest := sha256.Sum256([]byte(revision.ID + "\x00" + scenario.ScenarioID))
		suffix := hex.EncodeToString(digest[:])
		return campaigncompiler.Envelope{
			From:      mail.Address{Name: "Moosewave Assurance", Address: "assurance@example.test"},
			To:        []mail.Address{{Name: "Synthetic recipient", Address: "fixture@example.test"}},
			Date:      revision.CreatedAt.UTC(),
			MessageID: "<assurance." + suffix[:40] + "@example.test>",
			Boundary:  "postwave-assurance-" + suffix[:32],
		}, nil
	}
}
