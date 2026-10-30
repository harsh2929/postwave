// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignplanbuilder is the production boundary between one frozen
// campaign revision, complete synthetic scenario coverage, the canonical
// compiler, and durable artifact materialization. It performs no recipient
// lookup and accepts no real-recipient merge data.
package campaignplanbuilder

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

const (
	Version                       = "postwave.campaign-plan-builder.v1"
	TransformManifestVersion      = "postwave.campaign-plan-transform-manifest.v1"
	ReviewedVariantAdapterVersion = "postwave.reviewed-semantic-variant.v1"
	FrozenLocaleAdapterVersion    = "postwave.frozen-locales.v1"
	maxFrozenVariantBytes         = 64 << 20
)

var (
	ErrInvalidInput        = errors.New("campaign plan builder: invalid input")
	ErrVariantAdapter      = errors.New("campaign plan builder: frozen variant adapter rejected input")
	ErrLocaleAdapter       = errors.New("campaign plan builder: frozen locale adapter rejected input")
	ErrCoverage            = errors.New("campaign plan builder: scenario coverage failed")
	ErrCompile             = errors.New("campaign plan builder: scenario compilation failed")
	ErrCompiledSetMismatch = errors.New("campaign plan builder: compiled scenario set mismatch")
	ErrScenarioDrift       = errors.New("campaign plan builder: compiled scenario drift")
	ErrPlanDrift           = errors.New("campaign plan builder: send plan drift")
)

// EnvelopeFactory supplies deterministic synthetic wire metadata for exactly
// one frozen scenario. The scenario contains only code-owned synthetic slot
// values. Callers should derive Message-ID and MIME boundary from ScenarioID.
type EnvelopeFactory func(campaigncoverage.CompilationScenario) (campaigncompiler.Envelope, error)

type CompileInput struct {
	Revision               campaignartifact.Revision
	TrackingSettings       json.RawMessage
	StructuredPolicy       semanticemail.StructuredPolicy
	PolicyVersion          string
	EnvelopeFactoryVersion string
	EnvelopeFactory        EnvelopeFactory
}

// Bundle contains the complete, canonical scenario set in manifest order.
// CoverageManifest is the exact JSON that must be stored on the preparing send
// plan before FinalizeSyntheticPlan is called.
type Bundle struct {
	BuilderVersion      string
	VariantAdapter      string
	LocaleAdapter       string
	TenantID            string
	RevisionID          string
	CampaignID          string
	SourceHash          string
	RendererVersion     string
	CompilerVersion     string
	PolicyVersion       string
	EnvelopeFactory     string
	TrackingSettings    json.RawMessage
	StructuredPolicy    semanticemail.StructuredPolicy
	Manifest            campaigncoverage.Manifest
	CoverageManifest    json.RawMessage
	TransformManifest   json.RawMessage
	CoverageDiagnostics campaigncoverage.Diagnostics
	Compiled            []campaigncompiler.Result
}

// SyntheticPlanMaterializer is implemented by
// *campaignmaterializer.Materializer. The narrow interface keeps compilation
// tests pure and makes the final I/O handoff explicit.
type SyntheticPlanMaterializer interface {
	FinalizeSyntheticPlan(context.Context, campaignmaterializer.Input) (campaignmaterializer.Result, error)
}

type FinalizeInput struct {
	TenantID  string
	Plan      campaignartifact.Plan
	ExpiresAt time.Time
	Bundle    Bundle
}

type FinalizeResult struct {
	Bundle       Bundle
	Materialized campaignmaterializer.Result
}

type Builder struct {
	Materializer SyntheticPlanMaterializer
}
