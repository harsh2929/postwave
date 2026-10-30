// SPDX-License-Identifier: AGPL-3.0-only

// Package campaignmaterializer persists synthetic compiler projections to the
// tenant-scoped encrypted object store before atomically finalizing a frozen
// send plan. It never accepts or retains real-recipient MIME.
package campaignmaterializer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
)

const (
	ObjectReferenceVersion = "postwave.tenant-object-ref.v1"
	maxArtifactsPerPlan    = 4096
)

var (
	ErrInvalidInput      = errors.New("campaign materializer: invalid input")
	ErrIntegrityMismatch = errors.New("campaign materializer: compiler artifact integrity mismatch")
	ErrSyntheticRequired = errors.New("campaign materializer: synthetic fixture evidence is required")
)

// ObjectStore is intentionally compatible with uploads.Store's Put/Delete
// methods. Production uses its tenant-prefixed SSE-KMS S3 implementation.
type ObjectStore interface {
	Put(ctx context.Context, tenantID, rest, contentType string, body io.Reader) (key string, err error)
	Delete(ctx context.Context, tenantID, rest string) error
}

type PlanFinalizer interface {
	FinalizePlan(ctx context.Context, tenantID, planID string, artifacts []campaignartifact.ArtifactInput) (*campaignartifact.Plan, error)
}

type Input struct {
	TenantID         string
	CampaignID       string
	PlanID           string
	SyntheticFixture bool
	ExpiresAt        time.Time
	Compiled         []campaigncompiler.Result
}

type Result struct {
	Plan      campaignartifact.Plan
	Artifacts []campaignartifact.ArtifactInput
}

type Materializer struct {
	Objects   ObjectStore
	Finalizer PlanFinalizer
}

// FinalizeSyntheticPlan writes all projection objects, then asks the
// repository to atomically insert the artifact rows and transition the plan to
// ready. Object writes that fail before the database call are rolled back. If
// FinalizePlan returns an error, objects are deliberately retained for the
// orphan sweeper: a database commit followed by a lost response is ambiguous,
// and deleting in that case could destroy evidence referenced by a ready plan.
func (m *Materializer) FinalizeSyntheticPlan(ctx context.Context, input Input) (Result, error) {
	if m == nil || m.Objects == nil || m.Finalizer == nil {
		return Result{}, fmt.Errorf("%w: object store and plan finalizer are required", ErrInvalidInput)
	}
	if !input.SyntheticFixture {
		return Result{}, ErrSyntheticRequired
	}
	for _, identity := range []struct{ name, value string }{
		{name: "tenant_id", value: input.TenantID},
		{name: "campaign_id", value: input.CampaignID},
		{name: "plan_id", value: input.PlanID},
	} {
		if _, err := uuid.Parse(strings.TrimSpace(identity.value)); err != nil {
			return Result{}, fmt.Errorf("%w: invalid %s", ErrInvalidInput, identity.name)
		}
	}
	if input.ExpiresAt.IsZero() {
		return Result{}, fmt.Errorf("%w: expires_at is required", ErrInvalidInput)
	}
	if len(input.Compiled) == 0 || len(input.Compiled) > maxArtifactsPerPlan {
		return Result{}, fmt.Errorf("%w: compiled artifact count must be between 1 and %d", ErrInvalidInput, maxArtifactsPerPlan)
	}

	artifacts := make([]campaignartifact.ArtifactInput, len(input.Compiled))
	seenScenarios := make(map[string]struct{}, len(input.Compiled))
	for index, compiled := range input.Compiled {
		if err := verifyCompiled(compiled); err != nil {
			return Result{}, fmt.Errorf("compiled[%d]: %w", index, err)
		}
		scenarioID := strings.TrimSpace(compiled.Artifact.ScenarioID)
		if _, duplicate := seenScenarios[scenarioID]; duplicate {
			return Result{}, fmt.Errorf("%w: duplicate scenario_id %q", ErrInvalidInput, scenarioID)
		}
		seenScenarios[scenarioID] = struct{}{}
		artifact := compiled.Artifact
		if artifact.HTMLObjectRef != "" || artifact.TextObjectRef != "" || artifact.MIMEObjectRef != "" {
			return Result{}, fmt.Errorf("%w: compiler result contains caller-supplied object references", ErrInvalidInput)
		}
		expires := input.ExpiresAt.UTC()
		artifact.ExpiresAt = &expires
		artifacts[index] = artifact
	}

	type storedObject struct{ rest string }
	stored := make([]storedObject, 0, len(artifacts)*3)
	rollback := func() error {
		var rollbackErr error
		for index := len(stored) - 1; index >= 0; index-- {
			if err := m.Objects.Delete(context.WithoutCancel(ctx), input.TenantID, stored[index].rest); err != nil {
				rollbackErr = errors.Join(rollbackErr, fmt.Errorf("delete orphan %q: %w", stored[index].rest, err))
			}
		}
		return rollbackErr
	}

	for index, compiled := range input.Compiled {
		base := objectBase(input.PlanID, artifacts[index])
		objects := []struct {
			suffix      string
			contentType string
			body        []byte
			setRef      func(string)
		}{
			{suffix: artifacts[index].HTMLHash + ".html", contentType: "text/html; charset=utf-8", body: []byte(compiled.HTML), setRef: func(ref string) { artifacts[index].HTMLObjectRef = ref }},
			{suffix: artifacts[index].TextHash + ".txt", contentType: "text/plain; charset=utf-8", body: []byte(compiled.Text), setRef: func(ref string) { artifacts[index].TextObjectRef = ref }},
			{suffix: artifacts[index].OutboundMIMEHash + ".eml", contentType: "message/rfc822", body: compiled.RFC822, setRef: func(ref string) { artifacts[index].MIMEObjectRef = ref }},
		}
		for _, object := range objects {
			rest := base + "/" + object.suffix
			// Include the attempted key in rollback: an object API can return a
			// timeout after the remote side committed the write.
			stored = append(stored, storedObject{rest: rest})
			if _, err := m.Objects.Put(ctx, input.TenantID, rest, object.contentType, bytes.NewReader(object.body)); err != nil {
				return Result{}, errors.Join(fmt.Errorf("store %q: %w", rest, err), rollback())
			}
			object.setRef(FormatObjectReference(rest))
		}
	}

	plan, err := m.Finalizer.FinalizePlan(ctx, input.TenantID, input.PlanID, artifacts)
	if err != nil {
		return Result{}, fmt.Errorf("finalize plan (objects retained for orphan reconciliation): %w", err)
	}
	if plan == nil || plan.ID != input.PlanID || plan.CampaignID != input.CampaignID ||
		(plan.State != campaignartifact.PlanReady && plan.State != campaignartifact.PlanCertified) {
		return Result{}, fmt.Errorf("%w: finalizer returned an unrelated or non-ready plan", ErrIntegrityMismatch)
	}
	return Result{Plan: *plan, Artifacts: cloneArtifacts(artifacts)}, nil
}

func verifyCompiled(compiled campaigncompiler.Result) error {
	artifact := compiled.Artifact
	checks := []struct {
		name string
		got  string
		want string
	}{
		{name: "html_hash", got: digest([]byte(compiled.HTML)), want: artifact.HTMLHash},
		{name: "text_hash", got: digest([]byte(compiled.Text)), want: artifact.TextHash},
		{name: "outbound_mime_hash", got: digest(compiled.RFC822), want: artifact.OutboundMIMEHash},
		{name: "manifest_html_hash", got: compiled.RepresentationManifest.HTMLSHA256, want: artifact.HTMLHash},
		{name: "manifest_text_hash", got: compiled.RepresentationManifest.TextSHA256, want: artifact.TextHash},
		{name: "manifest_mime_hash", got: compiled.RepresentationManifest.OutboundMIMESHA256, want: artifact.OutboundMIMEHash},
		{name: "transform_output_hash", got: compiled.Receipt.Transform.OutputHTMLSHA256, want: artifact.HTMLHash},
	}
	if len(compiled.StructuredData) != 0 {
		checks = append(checks, struct{ name, got, want string }{
			name: "structured_data_hash", got: digest(compiled.StructuredData), want: artifact.StructuredDataHash,
		})
	} else if artifact.StructuredDataHash != "" {
		return fmt.Errorf("%w: structured_data_hash exists without bytes", ErrIntegrityMismatch)
	}
	for _, check := range checks {
		if check.got == "" || check.got != check.want {
			return fmt.Errorf("%w: %s", ErrIntegrityMismatch, check.name)
		}
	}
	receiptJSON, err := json.Marshal(compiled.Receipt)
	if err != nil || !bytes.Equal(receiptJSON, artifact.CompilerReceipt) {
		return fmt.Errorf("%w: compiler_receipt bytes differ from typed receipt", ErrIntegrityMismatch)
	}
	manifestJSON, err := json.Marshal(compiled.RepresentationManifest)
	if err != nil || !bytes.Equal(manifestJSON, artifact.RepresentationManifest) {
		return fmt.Errorf("%w: representation_manifest bytes differ from typed manifest", ErrIntegrityMismatch)
	}
	if strings.TrimSpace(artifact.ScenarioID) == "" || artifact.SourceHash == "" ||
		len(compiled.Artifact.CompilerReceipt) == 0 || len(compiled.Artifact.RepresentationManifest) == 0 {
		return fmt.Errorf("%w: incomplete artifact identity", ErrIntegrityMismatch)
	}
	return nil
}

func objectBase(planID string, artifact campaignartifact.ArtifactInput) string {
	scenarioDigest := digest([]byte(strings.TrimSpace(artifact.ScenarioID)))
	return "campaign-assurance/plans/" + planID + "/artifacts/" + scenarioDigest
}

// FormatObjectReference creates a non-URL, tenant-relative internal reference.
// Tenant ownership always comes from the authenticated row/context, never the
// reference itself.
func FormatObjectReference(rest string) string {
	return ObjectReferenceVersion + ":" + rest
}

func ParseObjectReference(reference string) (string, error) {
	prefix := ObjectReferenceVersion + ":"
	if !strings.HasPrefix(reference, prefix) {
		return "", fmt.Errorf("%w: unsupported object reference", ErrInvalidInput)
	}
	rest := strings.TrimPrefix(reference, prefix)
	if rest == "" || strings.HasPrefix(rest, "/") || strings.Contains(rest, "..") || strings.ContainsAny(rest, "\r\n\x00") {
		return "", fmt.Errorf("%w: unsafe object reference", ErrInvalidInput)
	}
	return rest, nil
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func cloneArtifacts(input []campaignartifact.ArtifactInput) []campaignartifact.ArtifactInput {
	out := make([]campaignartifact.ArtifactInput, len(input))
	copy(out, input)
	for index := range out {
		out[index].CompilerReceipt = append([]byte(nil), input[index].CompilerReceipt...)
		out[index].RepresentationManifest = append([]byte(nil), input[index].RepresentationManifest...)
		if input[index].ExpiresAt != nil {
			expires := *input[index].ExpiresAt
			out[index].ExpiresAt = &expires
		}
	}
	return out
}
