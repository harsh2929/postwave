// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/mail"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaigndelivery"
	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"github.com/postwave/postwave/apps/api/internal/sending"
)

// DispatchBound implements sending.AssuranceBoundDispatcher. All error
// results use stable non-PII reason codes; the wrapped error is diagnostic and
// must never be persisted as a campaign-recipient error message.
func (r *Runtime) DispatchBound(ctx context.Context, input sending.BoundDispatchInput) (sending.BoundDispatchResult, error) {
	if r == nil || r.Artifacts == nil || r.Assurance == nil || r.Gate == nil || r.Objects == nil || r.Recipients == nil || r.ReplyCorrelation == nil || r.Delivery == nil {
		return withheld(ReasonInvalidBinding, errors.New("campaign send runtime dependencies are incomplete"))
	}
	if err := validateBoundInput(input); err != nil {
		return withheld(ReasonInvalidBinding, err)
	}
	// Re-evaluate the same exact-hash authority that created the queue binding.
	// This happens before artifact/object reads and recipient compilation so a
	// revoked waiver or stale run cannot consume work, much less reach raw MIME
	// transport. The immutable delivery-ledger trigger rechecks the complete
	// override set again inside the eventual INSERT transaction.
	currentReceipt, err := r.Gate.ReauthorizeBound(ctx, campaignassurancegate.Request{
		TenantID: input.TenantID, CampaignID: input.CampaignID,
		ContentRevisionID: input.Binding.ContentRevisionID, SourceHash: input.Binding.SourceHash,
	})
	if err != nil {
		if campaignassurancegate.IsDenial(err) || errors.Is(err, campaignassurancegate.ErrInvalidInput) {
			return withheld(ReasonGateMismatch, err)
		}
		return retryable(ReasonGateMismatch, err)
	}
	if err := verifyCurrentGateReceipt(input, currentReceipt); err != nil {
		return withheld(ReasonGateMismatch, err)
	}

	evidence, refusal, err := r.loadFrozenEvidence(ctx, input)
	if err != nil {
		return refusal, err
	}
	resolved, refusal, err := r.resolveRecipientScenario(ctx, input, evidence)
	if err != nil {
		return refusal, err
	}
	source, values, locale, scenario, artifact := resolved.source, resolved.values, resolved.locale, resolved.scenario, resolved.artifact
	transform := evidence.transform
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	if artifact.ExpiresAt == nil || !artifact.ExpiresAt.After(now) {
		return withheld(ReasonArtifactObjectUnavailable, errors.New("selected synthetic artifact has expired"))
	}
	if err := verifySelectedObject(ctx, r.Objects, input.TenantID, artifact); err != nil {
		if errors.Is(err, errArtifactObjectIntegrity) {
			return withheld(ReasonArtifactObjectMismatch, err)
		}
		return retryable(ReasonArtifactObjectUnavailable, err)
	}
	pollOptionLinks := semanticemail.PollOptionLinks(nil)
	if documentHasPoll(source.document) {
		if r.Polls == nil {
			return withheld(ReasonPollLinksUnavailable, errors.New("semantic poll requires the campaign poll link minter"))
		}
		pollOptionLinks, err = r.Polls.MintLinks(ctx, input.TenantID, input.CampaignID,
			input.Binding.ContentRevisionID, strconv.FormatInt(input.CampaignRecipientID, 10),
			input.Binding.BoundAt.UTC(), source.document)
		if err != nil {
			return withheld(ReasonPollLinksUnavailable, err)
		}
	}

	// F01 honeypot decoys. Recipient-specific compiler input on the same footing
	// as poll links: never authored into the semantic revision and never part of
	// a stored assurance artifact.
	//
	// A minting failure is logged by the minter and skipped, NOT withheld. A
	// decoy is measurement, and a send that fails because the instrument failed
	// is strictly worse than a send with one less label.
	var honeypotDecoys []string
	if r.Honeypot != nil {
		honeypotDecoys, err = r.Honeypot.MintDecoys(
			input.TenantID, input.CampaignID, input.CampaignRecipientID, input.Binding.BoundAt.UTC())
		if err != nil {
			honeypotDecoys = nil
		}
	}

	deliveryID, err := campaigndelivery.DeriveDeliveryID(
		input.TenantID, input.CampaignID, input.CampaignRecipientID, input.Binding.SendPlanID,
	)
	if err != nil {
		return withheld(ReasonReplyCorrelationUnavailable, err)
	}
	correlation, err := r.ReplyCorrelation.Mint(replycorrelation.MintInput{
		TenantID: input.TenantID, CampaignID: input.CampaignID,
		DeliveryID: deliveryID, IssuedAt: input.Binding.BoundAt.UTC(),
	})
	if err != nil || correlation.DeliveryID != deliveryID {
		return withheld(ReasonReplyCorrelationUnavailable, errors.Join(err, errors.New("reply correlation identity does not match delivery")))
	}
	envelope, envelopeFrom, messageID, idempotencyKey, err := liveEnvelope(input, correlation.Address)
	if err != nil {
		return withheld(ReasonEnvelopeInvalid, err)
	}
	compiled, err := campaigncompiler.Compile(campaigncompiler.Input{
		Revision: source.revision, SemanticDocument: &source.document,
		Scenario: campaigncompiler.Scenario{
			ID: scenario.ID, VariantID: input.VariantID, Locale: locale,
			BranchKey: scenario.BranchKey, FixtureID: scenario.FixtureID,
			Slots: maps.Clone(values.Slots),
		},
		TrackingSettings: append(json.RawMessage(nil), transform.TrackingSettings...),
		StructuredPolicy: transform.StructuredPolicy, PollOptionLinks: pollOptionLinks,
		HoneypotDecoys: honeypotDecoys, Envelope: envelope,
	})
	if err != nil {
		return withheld(ReasonCompileFailed, err)
	}
	if err := verifyLiveCompilation(compiled, source, scenario, artifact); err != nil {
		return withheld(ReasonMIMEIntegrity, err)
	}

	result, err := r.Delivery.Dispatch(ctx, campaigndelivery.Request{
		Attempt: campaigndelivery.AttemptInput{
			DeliveryID: deliveryID, TenantID: input.TenantID, CampaignID: input.CampaignID,
			CampaignRecipientID: input.CampaignRecipientID, SendPlanID: input.Binding.SendPlanID,
			ArtifactID: artifact.ID, AssuranceRunID: input.Binding.RunID,
			AssuranceAttemptCount: input.Binding.RunAttempt, ArtifactSetHash: input.Binding.ArtifactSetHash,
			GateDecision:    input.Binding.GateDecision,
			GateOverrideIDs: append([]string(nil), input.Binding.OverrideIDs...),
			ScenarioID:      scenario.ID, SourceHash: input.Binding.SourceHash, PlanHash: input.Binding.PlanHash,
			CompilerVersion: campaigncompiler.Version, OutboundMIMEHash: compiled.RepresentationManifest.OutboundMIMESHA256,
			MessageID: messageID, ReplyTo: correlation.Address,
			ReplyCorrelationVersion:   correlation.Version,
			ReplyCorrelationKeyID:     correlation.KeyID,
			ReplyCorrelationExpiresAt: &correlation.ExpiresAt,
			ReplyCorrelationTokenHash: correlation.TokenHash,
			IdempotencyKey:            idempotencyKey,
		},
		Recipient: input.Recipient, Messenger: input.Messenger,
		Message: campaigntransport.CompiledMessage{
			ArtifactID: artifact.ID, ScenarioID: scenario.ID, CampaignID: input.CampaignID,
			MessageID: messageID, ReplyTo: correlation.Address,
			EnvelopeFrom: envelopeFrom, To: []string{input.Recipient},
			RFC822: append([]byte(nil), compiled.RFC822...), MIMEHash: compiled.RepresentationManifest.OutboundMIMESHA256,
		},
	})
	if err != nil {
		return mapDeliveryError(err)
	}
	if result.Attempt.State != campaigndelivery.StateAccepted ||
		result.Attempt.OutboundMIMEHash != compiled.RepresentationManifest.OutboundMIMESHA256 ||
		result.Attempt.ArtifactID != artifact.ID || result.Attempt.ScenarioID != scenario.ID ||
		result.Attempt.ID != deliveryID || result.Attempt.MessageID != messageID ||
		result.Attempt.ReplyTo != correlation.Address ||
		result.Attempt.ReplyCorrelationTokenHash != correlation.TokenHash {
		return sending.BoundDispatchResult{Status: sending.BoundDispatchIndeterminate, Reason: ReasonDeliveryIndeterminate},
			errors.New("delivery coordinator returned a non-accepted or unrelated receipt")
	}
	return sending.BoundDispatchResult{Status: sending.BoundDispatchAccepted, Replayed: result.Replayed}, nil
}

// frozenEvidence is the immutable send authority DispatchBound loads and
// verifies before any recipient-specific work: the frozen revision, plan,
// synthetic artifacts, assurance run manifest, and the plan's decoded coverage
// and transform manifests.
type frozenEvidence struct {
	revision    campaignartifact.Revision
	plan        campaignartifact.Plan
	artifacts   []campaignartifact.Artifact
	runManifest *campaignassurance.ClaimedRun
	coverage    campaigncoverage.Manifest
	transform   frozenTransformManifest
}

func noEvidence(result sending.BoundDispatchResult, err error) (frozenEvidence, sending.BoundDispatchResult, error) {
	return frozenEvidence{}, result, err
}

// loadFrozenEvidence reads and verifies the frozen artifact, plan, and
// assurance evidence the recipient binding names. A failure carries the
// withheld/retryable result the dispatch must return.
func (r *Runtime) loadFrozenEvidence(ctx context.Context, input sending.BoundDispatchInput) (frozenEvidence, sending.BoundDispatchResult, error) {
	revision, err := r.Artifacts.GetRevision(ctx, input.TenantID, input.CampaignID, input.Binding.ContentRevisionID)
	if err != nil {
		if errors.Is(err, campaignartifact.ErrNotFound) {
			return noEvidence(withheld(ReasonRevisionUnavailable, err))
		}
		return noEvidence(retryable(ReasonRevisionUnavailable, err))
	}
	if revision == nil {
		return noEvidence(withheld(ReasonRevisionUnavailable, errors.New("artifact reader returned a nil revision")))
	}
	plan, err := r.Artifacts.GetPlan(ctx, input.TenantID, input.CampaignID, input.Binding.SendPlanID)
	if err != nil {
		if errors.Is(err, campaignartifact.ErrNotFound) {
			return noEvidence(withheld(ReasonPlanUnavailable, err))
		}
		return noEvidence(retryable(ReasonPlanUnavailable, err))
	}
	if plan == nil {
		return noEvidence(withheld(ReasonPlanUnavailable, errors.New("artifact reader returned a nil plan")))
	}
	artifacts, err := r.Artifacts.ListArtifacts(ctx, input.TenantID, input.CampaignID, input.Binding.SendPlanID)
	if err != nil {
		if errors.Is(err, campaignartifact.ErrNotFound) {
			return noEvidence(withheld(ReasonArtifactsUnavailable, err))
		}
		return noEvidence(retryable(ReasonArtifactsUnavailable, err))
	}
	runManifest, err := r.Assurance.GetRunManifest(ctx, input.TenantID, input.Binding.RunID)
	if err != nil {
		if errors.Is(err, campaignassurance.ErrNotFound) {
			return noEvidence(withheld(ReasonRunUnavailable, err))
		}
		return noEvidence(retryable(ReasonRunUnavailable, err))
	}
	if runManifest == nil {
		return noEvidence(withheld(ReasonRunUnavailable, errors.New("assurance reader returned a nil run manifest")))
	}
	coverage, err := decodeCoverage(*plan)
	if err != nil {
		return noEvidence(withheld(ReasonCoverageMismatch, err))
	}
	transform, err := decodeTransformManifest(*plan)
	if err != nil {
		return noEvidence(withheld(ReasonPlanMismatch, err))
	}
	if err := verifyFrozenEvidence(input, *revision, *plan, runManifest, coverage, artifacts); err != nil {
		return noEvidence(withheld(frozenEvidenceReason(err), err))
	}
	return frozenEvidence{
		revision: *revision, plan: *plan, artifacts: artifacts,
		runManifest: runManifest, coverage: coverage, transform: transform,
	}, sending.BoundDispatchResult{}, nil
}

// resolvedScenario is the recipient-specific selection DispatchBound compiles:
// the variant source, resolved recipient values, locale, the assured coverage
// scenario they map to, and that scenario's synthetic artifact.
type resolvedScenario struct {
	source   selectedSource
	values   RecipientValues
	locale   string
	scenario campaigncoverage.Scenario
	artifact campaignartifact.Artifact
}

func noScenario(result sending.BoundDispatchResult, err error) (resolvedScenario, sending.BoundDispatchResult, error) {
	return resolvedScenario{}, result, err
}

// resolveRecipientScenario resolves the recipient's values and maps them onto
// exactly one assured coverage scenario and its artifact. A failure carries
// the withheld/retryable result the dispatch must return.
func (r *Runtime) resolveRecipientScenario(ctx context.Context, input sending.BoundDispatchInput, evidence frozenEvidence) (resolvedScenario, sending.BoundDispatchResult, error) {
	source, err := selectSource(evidence.revision, evidence.coverage, input.VariantID)
	if err != nil {
		return noScenario(withheld(ReasonVariantUnsupported, err))
	}
	values, err := r.Recipients.ResolveRecipient(ctx, RecipientResolveInput{
		TenantID: input.TenantID, CampaignID: input.CampaignID, Recipient: input.Recipient,
		RequestedSlots:   append([]semanticemail.SlotID(nil), source.requestedSlots...),
		AvailableLocales: append([]string(nil), evidence.coverage.Locales...),
	})
	if err != nil {
		if errors.Is(err, ErrRecipientValuesUnsupported) {
			return noScenario(withheld(ReasonPersonalizationUnavailable, err))
		}
		return noScenario(retryable(ReasonPersonalizationUnavailable, err))
	}
	values, err = normalizeRecipientValues(values)
	if err != nil {
		return noScenario(withheld(ReasonPersonalizationUnavailable, err))
	}
	if err := validateResolvedSlots(source.requestedSlots, values.Slots); err != nil {
		return noScenario(withheld(ReasonPersonalizationUnavailable, err))
	}
	locale, err := resolveLocale(values.Locale, evidence.coverage)
	if err != nil {
		return noScenario(withheld(ReasonLocaleUnsupported, err))
	}
	branch, err := branchForValues(source.document, source.manifestID, values.Slots, evidence.coverage)
	if err != nil {
		return noScenario(withheld(ReasonBranchUnsupported, err))
	}
	scenario, err := selectScenario(evidence.coverage, source.manifestID, locale, branch.Key, source.requestedSlots, values.Slots)
	if err != nil {
		return noScenario(withheld(ReasonFixtureUnsupported, err))
	}
	artifact, err := selectedArtifact(evidence.artifacts, scenario.ID)
	if err != nil {
		return noScenario(withheld(ReasonArtifactMismatch, err))
	}
	return resolvedScenario{source: source, values: values, locale: locale, scenario: scenario, artifact: artifact}, sending.BoundDispatchResult{}, nil
}

func documentHasPoll(document semanticemail.DocumentV2) bool {
	for _, node := range document.Nodes {
		if node.Type == semanticemail.NodePoll && node.Content.Poll != nil {
			return true
		}
	}
	return false
}

func verifyCurrentGateReceipt(input sending.BoundDispatchInput, receipt campaignassurancegate.Receipt) error {
	binding := input.Binding
	if receipt.PolicyVersion != campaignassurancegate.PolicyVersion || receipt.TenantID != input.TenantID ||
		receipt.CampaignID != input.CampaignID || receipt.ContentRevisionID != binding.ContentRevisionID ||
		receipt.SendPlanID != binding.SendPlanID || receipt.RunID != binding.RunID ||
		receipt.RunAttempt != binding.RunAttempt || receipt.ArtifactSetHash != binding.ArtifactSetHash ||
		receipt.SourceHash != binding.SourceHash || receipt.PlanHash != binding.PlanHash ||
		receipt.Decision != binding.GateDecision || receipt.AuthorizedAt.IsZero() ||
		!slices.Equal(receipt.OverrideIDs, binding.OverrideIDs) {
		return errors.New("current Campaign Assurance receipt differs from immutable queue binding")
	}
	return nil
}

func validateBoundInput(input sending.BoundDispatchInput) error {
	for _, field := range []struct{ name, value string }{
		{"tenant_id", input.TenantID}, {"campaign_id", input.CampaignID},
		{"content_revision_id", input.Binding.ContentRevisionID}, {"send_plan_id", input.Binding.SendPlanID},
		{"assurance_run_id", input.Binding.RunID},
	} {
		parsed, err := uuid.Parse(strings.TrimSpace(field.value))
		if err != nil || parsed.String() != field.value {
			return fmt.Errorf("%s must be a canonical UUID", field.name)
		}
	}
	if input.CampaignRecipientID <= 0 || input.Binding.RunAttempt < 1 || input.Binding.BoundAt == nil || input.Binding.BoundAt.IsZero() {
		return errors.New("recipient, run attempt, and bound timestamp are required")
	}
	for _, value := range []string{input.Binding.ArtifactSetHash, input.Binding.SourceHash, input.Binding.PlanHash} {
		if !validSHA256(value) {
			return errors.New("binding hashes must be lowercase SHA-256")
		}
	}
	recipient, err := mail.ParseAddress(strings.TrimSpace(input.Recipient))
	if err != nil || !strings.EqualFold(recipient.Address, strings.TrimSpace(input.Recipient)) {
		return errors.New("recipient must be one bare mailbox")
	}
	if len(input.Binding.OverrideIDs) > 100 || !sortedUniqueOverrideIDs(input.Binding.OverrideIDs) {
		return errors.New("override ids must be a sorted unique set of at most 100 ids")
	}
	for _, overrideID := range input.Binding.OverrideIDs {
		parsed, err := uuid.Parse(overrideID)
		if err != nil || parsed.String() != overrideID {
			return errors.New("override ids must be canonical UUIDs")
		}
	}
	return nil
}

func validateResolvedSlots(requested []semanticemail.SlotID, values map[semanticemail.SlotID]string) error {
	allowed := make(map[semanticemail.SlotID]struct{}, len(requested))
	for _, slot := range requested {
		allowed[slot] = struct{}{}
	}
	for slot := range values {
		if _, ok := allowed[slot]; !ok {
			return fmt.Errorf("resolver returned undeclared slot %q", slot)
		}
		if !utf8.ValidString(values[slot]) {
			return fmt.Errorf("resolver returned invalid UTF-8 for slot %q", slot)
		}
	}
	return nil
}

func liveEnvelope(input sending.BoundDispatchInput, correlationReplyTo string) (campaigncompiler.Envelope, string, string, string, error) {
	from := mail.Address{Name: strings.TrimSpace(input.FromName), Address: strings.TrimSpace(input.FromEmail)}
	parsedFrom, err := mail.ParseAddress(from.String())
	if err != nil || !strings.EqualFold(parsedFrom.Address, from.Address) {
		return campaigncompiler.Envelope{}, "", "", "", errors.New("campaign From is invalid")
	}
	to, err := mail.ParseAddress(strings.TrimSpace(input.Recipient))
	if err != nil {
		return campaigncompiler.Envelope{}, "", "", "", errors.New("recipient is invalid")
	}
	correlationReplyTo = strings.ToLower(strings.TrimSpace(correlationReplyTo))
	parsedReplyTo, parseErr := mail.ParseAddress(correlationReplyTo)
	if parseErr != nil || parsedReplyTo == nil || parsedReplyTo.Address != correlationReplyTo {
		return campaigncompiler.Envelope{}, "", "", "", errors.New("signed Reply-To is invalid")
	}
	replyTo := []mail.Address{*parsedReplyTo}
	headers := maps.Clone(input.Headers)
	for key := range headers {
		if strings.EqualFold(key, "From") || strings.EqualFold(key, "Reply-To") {
			delete(headers, key)
		}
	}
	unsubscribe, unsubscribeOK := uniqueHeaderValue(headers, "List-Unsubscribe")
	post, postOK := uniqueHeaderValue(headers, "List-Unsubscribe-Post")
	if !unsubscribeOK || !postOK || post != "List-Unsubscribe=One-Click" || !containsSafeHTTPSUnsubscribe(unsubscribe) {
		return campaigncompiler.Envelope{}, "", "", "", errors.New("one-click unsubscribe headers are required")
	}
	// Raw delivery currently performs no open-pixel or click-link injection.
	// Stamp that privacy-safe decision explicitly instead of allowing an absent
	// Listmonk feature to masquerade as enabled tracking.
	headers["X-Postwave-No-Open-Track"] = "1"
	headers["X-Postwave-No-Click-Track"] = "1"
	seed, err := digestJSON(struct {
		Version     string `json:"version"`
		TenantID    string `json:"tenant_id"`
		CampaignID  string `json:"campaign_id"`
		RecipientID int64  `json:"campaign_recipient_id"`
		PlanID      string `json:"send_plan_id"`
		RunID       string `json:"assurance_run_id"`
		BoundAt     string `json:"bound_at"`
	}{Version: Version, TenantID: input.TenantID, CampaignID: input.CampaignID,
		RecipientID: input.CampaignRecipientID, PlanID: input.Binding.SendPlanID,
		RunID: input.Binding.RunID, BoundAt: input.Binding.BoundAt.UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return campaigncompiler.Envelope{}, "", "", "", err
	}
	domain := ""
	if split := strings.LastIndex(from.Address, "@"); split >= 0 {
		domain = strings.ToLower(from.Address[split+1:])
	}
	if domain == "" {
		return campaigncompiler.Envelope{}, "", "", "", errors.New("From domain is missing")
	}
	messageID := "<pw." + seed[:40] + "@" + domain + ">"
	idempotencyKey := "cr:" + strconv.FormatInt(input.CampaignRecipientID, 10) + ":plan:" + input.Binding.SendPlanID
	return campaigncompiler.Envelope{
		From: from, To: []mail.Address{*to}, ReplyTo: replyTo, Headers: headers,
		Date: input.Binding.BoundAt.UTC(), MessageID: messageID, Boundary: "pw-" + seed,
	}, from.Address, messageID, idempotencyKey, nil
}

func uniqueHeaderValue(headers map[string]string, wanted string) (string, bool) {
	value := ""
	found := false
	for name, candidate := range headers {
		if !strings.EqualFold(strings.TrimSpace(name), wanted) {
			continue
		}
		if found {
			return "", false
		}
		value, found = strings.TrimSpace(candidate), true
	}
	return value, found && value != ""
}

func containsSafeHTTPSUnsubscribe(value string) bool {
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if len(item) < 3 || item[0] != '<' || item[len(item)-1] != '>' {
			continue
		}
		parsed, err := url.Parse(strings.TrimSpace(item[1 : len(item)-1]))
		if err == nil && strings.EqualFold(parsed.Scheme, "https") && parsed.Host != "" &&
			parsed.User == nil && parsed.Fragment == "" {
			return true
		}
	}
	return false
}

func verifyLiveCompilation(compiled campaigncompiler.Result, source selectedSource, scenario campaigncoverage.Scenario, artifact campaignartifact.Artifact) error {
	if err := verifyCompiledIdentity(compiled, source, scenario, artifact); err != nil {
		return err
	}
	if artifact.StructuredDataHash == "" {
		if len(compiled.StructuredData) != 0 || compiled.Artifact.StructuredDataHash != "" || compiled.RepresentationManifest.StructuredDataPresent {
			return errors.New("live compilation introduced structured data outside the assured scenario")
		}
	} else if digestBytes(compiled.StructuredData) != artifact.StructuredDataHash ||
		compiled.Artifact.StructuredDataHash != artifact.StructuredDataHash ||
		!compiled.RepresentationManifest.StructuredDataPresent {
		return errors.New("live structured data differs from the assured scenario")
	}
	included := make([]string, len(compiled.Receipt.IncludedNodeIDs))
	for index, node := range compiled.Receipt.IncludedNodeIDs {
		included[index] = string(node)
	}
	if !slices.Equal(included, scenario.IncludedNodeIDs) {
		return errors.New("live recipient condition output differs from selected assured scenario")
	}
	return verifySyntheticReceiptParity(compiled, artifact)
}

// verifyCompiledIdentity proves the live compiler result is internally
// consistent and bound to the selected scenario, source, and artifact MIME
// structure.
func verifyCompiledIdentity(compiled campaigncompiler.Result, source selectedSource, scenario campaigncoverage.Scenario, artifact campaignartifact.Artifact) error {
	if compiled.Artifact.ScenarioID != scenario.ID || compiled.Artifact.VariantID != source.variantID ||
		compiled.Artifact.Locale != scenario.Locale || compiled.Artifact.BranchKey != scenario.BranchKey ||
		compiled.Artifact.FixtureID != scenario.FixtureID || compiled.Artifact.SourceHash != source.revision.SourceHash ||
		compiled.Receipt.CompilerVersion != campaigncompiler.Version ||
		compiled.Receipt.SourceMode != campaignartifact.SourceModeSemantic ||
		compiled.Receipt.SourceHash != source.revision.SourceHash ||
		compiled.Receipt.ContentSchema != semanticemail.SchemaVersionV2 ||
		compiled.Receipt.SemanticDocumentSHA256 != source.documentHash ||
		compiled.Receipt.Transform.Version == "" ||
		compiled.RepresentationManifest.OutboundMIMESHA256 != compiled.Artifact.OutboundMIMEHash ||
		compiled.RepresentationManifest.MIMEStructureSHA256 != artifact.MIMEStructureHash ||
		digestBytes(compiled.RFC822) != compiled.Artifact.OutboundMIMEHash ||
		digestBytes([]byte(compiled.HTML)) != compiled.Artifact.HTMLHash ||
		digestBytes([]byte(compiled.Text)) != compiled.Artifact.TextHash ||
		!canonicalReceiptEqual(compiled.Artifact.CompilerReceipt, compiled.Receipt) ||
		!canonicalReceiptEqual(compiled.Artifact.RepresentationManifest, compiled.RepresentationManifest) {
		return errors.New("live compiler result is internally inconsistent or outside the selected artifact structure")
	}
	return nil
}

// verifySyntheticReceiptParity proves the live compiler implementation and
// transform match the receipt and representation manifest of the assured
// synthetic artifact.
func verifySyntheticReceiptParity(compiled campaigncompiler.Result, artifact campaignartifact.Artifact) error {
	var syntheticReceipt campaigncompiler.Receipt
	var syntheticRepresentation campaigncompiler.RepresentationManifest
	if strictDecode(artifact.CompilerReceipt, &syntheticReceipt) != nil ||
		strictDecode(artifact.RepresentationManifest, &syntheticRepresentation) != nil ||
		syntheticReceipt.CompilerVersion != compiled.Receipt.CompilerVersion ||
		syntheticReceipt.SourceMode != compiled.Receipt.SourceMode ||
		syntheticReceipt.SourceHash != compiled.Receipt.SourceHash ||
		syntheticReceipt.ContentSchema != compiled.Receipt.ContentSchema ||
		syntheticReceipt.SemanticDocumentSHA256 != compiled.Receipt.SemanticDocumentSHA256 ||
		syntheticReceipt.SemanticCompiler != compiled.Receipt.SemanticCompiler ||
		syntheticReceipt.HTMLRenderer != compiled.Receipt.HTMLRenderer ||
		syntheticReceipt.TextRenderer != compiled.Receipt.TextRenderer ||
		syntheticReceipt.StructuredRegistry != compiled.Receipt.StructuredRegistry ||
		syntheticReceipt.MIMEFormat != compiled.Receipt.MIMEFormat ||
		syntheticReceipt.MIMEContentHash != compiled.Receipt.MIMEContentHash ||
		!slices.Equal(syntheticReceipt.StructuredStatuses, compiled.Receipt.StructuredStatuses) ||
		syntheticReceipt.Transform.Version != compiled.Receipt.Transform.Version ||
		syntheticReceipt.Transform.PreviewInserted != compiled.Receipt.Transform.PreviewInserted ||
		syntheticReceipt.Transform.PreviewTextHash != compiled.Receipt.Transform.PreviewTextHash ||
		!maps.Equal(syntheticReceipt.Transform.UTMParameters, compiled.Receipt.Transform.UTMParameters) ||
		syntheticRepresentation.Version != compiled.RepresentationManifest.Version ||
		syntheticRepresentation.SourceMode != compiled.RepresentationManifest.SourceMode ||
		syntheticRepresentation.Locale != compiled.RepresentationManifest.Locale ||
		syntheticRepresentation.PlainTextOrigin != compiled.RepresentationManifest.PlainTextOrigin ||
		!slices.Equal(syntheticRepresentation.AlternativeOrder, compiled.RepresentationManifest.AlternativeOrder) ||
		syntheticRepresentation.StructuredDataSHA256 != compiled.RepresentationManifest.StructuredDataSHA256 ||
		syntheticRepresentation.SemanticDocumentSHA256 != compiled.RepresentationManifest.SemanticDocumentSHA256 ||
		syntheticRepresentation.MIMEStructureSHA256 != compiled.RepresentationManifest.MIMEStructureSHA256 ||
		syntheticRepresentation.StructuredDataPresent != compiled.RepresentationManifest.StructuredDataPresent {
		return errors.New("live compiler implementation/transform differs from selected assured receipt")
	}
	return nil
}

func mapDeliveryError(err error) (sending.BoundDispatchResult, error) {
	switch {
	case errors.Is(err, campaigndelivery.ErrDeliveryIndeterminate):
		return sending.BoundDispatchResult{Status: sending.BoundDispatchIndeterminate, Reason: ReasonDeliveryIndeterminate}, err
	case errors.Is(err, campaigndelivery.ErrAttemptInFlight), errors.Is(err, campaigndelivery.ErrLeaseLost):
		return sending.BoundDispatchResult{Status: sending.BoundDispatchRetryable, Reason: ReasonDeliveryUnavailable}, err
	case errors.Is(err, campaigndelivery.ErrAttemptRejected), campaigntransport.FailureDispositionOf(err) == campaigntransport.FailureDefinitelyNotSent:
		return sending.BoundDispatchResult{Status: sending.BoundDispatchRejected, Reason: ReasonDeliveryRejected}, err
	case errors.Is(err, campaigndelivery.ErrInvalidInput), errors.Is(err, campaigndelivery.ErrIntegrityMismatch), errors.Is(err, campaigndelivery.ErrIdempotencyConflict):
		return sending.BoundDispatchResult{Status: sending.BoundDispatchWithheld, Reason: ReasonDeliveryUnavailable}, err
	default:
		// An untyped coordinator error does not prove whether the provider
		// boundary was crossed. Treat it as indeterminate and never auto-retry.
		return sending.BoundDispatchResult{Status: sending.BoundDispatchIndeterminate, Reason: ReasonDeliveryIndeterminate}, err
	}
}

func withheld(reason string, err error) (sending.BoundDispatchResult, error) {
	return sending.BoundDispatchResult{Status: sending.BoundDispatchWithheld, Reason: reason}, err
}

func retryable(reason string, err error) (sending.BoundDispatchResult, error) {
	return sending.BoundDispatchResult{Status: sending.BoundDispatchRetryable, Reason: reason}, err
}
