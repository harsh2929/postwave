// SPDX-License-Identifier: AGPL-3.0-only

package campaignassuranceworker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/mail"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
	"github.com/postwave/postwave/apps/api/internal/campaigncoverage"
	"github.com/postwave/postwave/apps/api/internal/campaignmaterializer"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
	"golang.org/x/net/html"
	"golang.org/x/text/language"
)

const reviewedVariantAdapterVersion = "postwave.reviewed-semantic-variant.v1"

type frozenInputs struct {
	plan      campaignartifact.Plan
	revision  campaignartifact.Revision
	coverage  campaigncoverage.Manifest
	scenarios map[string]campaigncoverage.Scenario
}

type loadedArtifact struct {
	artifact    campaignartifact.Artifact
	revision    campaignartifact.Revision
	compilation campaigncompiler.Result
}

type reviewedVariant struct {
	AdapterVersion string                   `json:"adapter_version"`
	ID             string                   `json:"id"`
	Subject        string                   `json:"subject"`
	Document       semanticemail.DocumentV2 `json:"document"`
}

func (w *Worker) loadFrozenInputs(ctx context.Context, claimed *campaignassurance.ClaimedRun) (frozenInputs, error) {
	run := claimed.Run
	plan, err := w.Artifacts.GetPlan(ctx, run.TenantID, run.CampaignID, run.SendPlanID)
	if err != nil {
		return frozenInputs{}, classifyArtifactRead("send plan", err)
	}
	revision, err := w.Artifacts.GetRevision(ctx, run.TenantID, run.CampaignID, run.ContentRevisionID)
	if err != nil {
		return frozenInputs{}, classifyArtifactRead("content revision", err)
	}
	if plan == nil || revision == nil {
		return frozenInputs{}, fmt.Errorf("%w: repository returned a nil frozen parent", ErrManifestIntegrity)
	}
	if _, err := canonicalJSONObject(plan.TransformManifest, campaignchecks.MaxReceiptJSONBytes); err != nil {
		return frozenInputs{}, fmt.Errorf("%w: transform manifest is invalid or over limit", ErrManifestIntegrity)
	}
	if plan.ID != run.SendPlanID || plan.TenantID != run.TenantID || plan.CampaignID != run.CampaignID ||
		plan.ContentRevisionID != run.ContentRevisionID || (plan.State != campaignartifact.PlanReady && plan.State != campaignartifact.PlanCertified) ||
		plan.PlanHash == nil || *plan.PlanHash != run.PlanHash || plan.RendererVersion != run.RendererVersion ||
		plan.CompilerVersion != run.CompilerVersion || plan.FixtureSetVersion != run.FixtureSetVersion ||
		plan.PolicyVersion != run.PlanPolicyVersion {
		return frozenInputs{}, fmt.Errorf("%w: send plan differs from the claimed run snapshot", ErrManifestIntegrity)
	}
	if revision.ID != run.ContentRevisionID || revision.TenantID != run.TenantID ||
		revision.CampaignID != run.CampaignID || revision.SourceHash != run.SourceHash {
		return frozenInputs{}, fmt.Errorf("%w: content revision differs from the claimed run snapshot", ErrManifestIntegrity)
	}
	if revisionSize(*revision) > w.Config.MaxRevisionBytes {
		return frozenInputs{}, fmt.Errorf("%w: frozen revision exceeds configured bound", ErrObjectTooLarge)
	}

	canonicalCoverage, err := canonicalJSONObject(plan.CoverageManifest, campaigncoverage.MaxManifestBytes)
	if err != nil || digestBytes(canonicalCoverage) != run.CoverageManifestHash {
		return frozenInputs{}, fmt.Errorf("%w: coverage manifest hash or shape differs", ErrManifestIntegrity)
	}
	var coverage campaigncoverage.Manifest
	if err := decodeStrict(canonicalCoverage, &coverage); err != nil {
		return frozenInputs{}, fmt.Errorf("%w: coverage manifest strict decode", ErrManifestIntegrity)
	}
	if diagnostics := campaigncoverage.ValidateManifest(coverage); diagnostics.HasErrors() {
		return frozenInputs{}, fmt.Errorf("%w: coverage manifest validation", ErrManifestIntegrity)
	}
	if coverage.SourceHash != run.SourceHash || coverage.FixtureSetVersion != run.FixtureSetVersion {
		return frozenInputs{}, fmt.Errorf("%w: coverage source or fixture identity differs", ErrManifestIntegrity)
	}
	scenarios := make(map[string]campaigncoverage.Scenario, len(coverage.Scenarios))
	for _, scenario := range coverage.Scenarios {
		scenarios[scenario.ID] = scenario
	}
	if len(claimed.Artifacts) != len(coverage.Scenarios) {
		return frozenInputs{}, fmt.Errorf("%w: artifact set does not cover every required scenario", ErrManifestIntegrity)
	}
	seenScenarios := make(map[string]struct{}, len(claimed.Artifacts))
	for _, artifact := range claimed.Artifacts {
		if _, ok := scenarios[artifact.ScenarioID]; !ok {
			return frozenInputs{}, fmt.Errorf("%w: snapshotted artifact is outside coverage", ErrManifestIntegrity)
		}
		if _, duplicate := seenScenarios[artifact.ScenarioID]; duplicate {
			return frozenInputs{}, fmt.Errorf("%w: duplicate snapshotted coverage scenario", ErrManifestIntegrity)
		}
		seenScenarios[artifact.ScenarioID] = struct{}{}
	}
	return frozenInputs{plan: *plan, revision: *revision, coverage: coverage, scenarios: scenarios}, nil
}

func (w *Worker) loadArtifact(ctx context.Context, frozen frozenInputs, snapshot campaignassurance.RunArtifact) (loadedArtifact, error) {
	runTenant, runCampaign, runPlan := snapshot.TenantID, snapshot.CampaignID, snapshot.SendPlanID
	artifact, err := w.Artifacts.GetArtifact(ctx, runTenant, runCampaign, runPlan, snapshot.ArtifactID)
	if err != nil {
		return loadedArtifact{}, classifyArtifactRead("render artifact", err)
	}
	if artifact == nil {
		return loadedArtifact{}, fmt.Errorf("%w: repository returned a nil render artifact", ErrArtifactIntegrity)
	}
	scenario, ok := frozen.scenarios[snapshot.ScenarioID]
	if !ok || artifact.ID != snapshot.ArtifactID || artifact.TenantID != runTenant || artifact.SendPlanID != runPlan ||
		artifact.ScenarioID != snapshot.ScenarioID || artifact.OutboundMIMEHash != snapshot.OutboundMIMEHash ||
		artifact.MIMEStructureHash != snapshot.MIMEStructureHash || artifact.SourceHash != frozen.revision.SourceHash ||
		artifact.Locale != scenario.Locale || artifact.BranchKey != scenario.BranchKey || artifact.FixtureID != scenario.FixtureID {
		return loadedArtifact{}, fmt.Errorf("%w: render artifact differs from run or coverage snapshot", ErrArtifactIntegrity)
	}
	wantVariant := scenario.VariantID
	if wantVariant == "control" {
		wantVariant = ""
	}
	if artifact.VariantID != wantVariant {
		return loadedArtifact{}, fmt.Errorf("%w: render artifact variant differs from coverage", ErrArtifactIntegrity)
	}
	if artifact.ExpiresAt == nil || !artifact.ExpiresAt.After(w.Config.Now()) {
		return loadedArtifact{}, fmt.Errorf("%w: render artifact objects lack a live retention bound", ErrArtifactIntegrity)
	}

	objectBase := "campaign-assurance/plans/" + runPlan + "/artifacts/" + digestBytes([]byte(artifact.ScenarioID)) + "/"
	htmlBytes, err := w.readObject(ctx, runTenant, artifact.HTMLObjectRef,
		objectBase+artifact.HTMLHash+".html", "text/html", w.Config.MaxHTMLBytes)
	if err != nil {
		return loadedArtifact{}, fmt.Errorf("html artifact: %w", err)
	}
	textBytes, err := w.readObject(ctx, runTenant, artifact.TextObjectRef,
		objectBase+artifact.TextHash+".txt", "text/plain", w.Config.MaxTextBytes)
	if err != nil {
		return loadedArtifact{}, fmt.Errorf("plain-text artifact: %w", err)
	}
	mimeBytes, err := w.readObject(ctx, runTenant, artifact.MIMEObjectRef,
		objectBase+artifact.OutboundMIMEHash+".eml", "message/rfc822", w.Config.MaxMIMEBytes)
	if err != nil {
		return loadedArtifact{}, fmt.Errorf("MIME artifact: %w", err)
	}
	for _, check := range []struct {
		name, actual, expected string
	}{
		{"HTML", digestBytes(htmlBytes), artifact.HTMLHash},
		{"plain text", digestBytes(textBytes), artifact.TextHash},
		{"MIME", digestBytes(mimeBytes), artifact.OutboundMIMEHash},
	} {
		if check.actual != check.expected {
			return loadedArtifact{}, fmt.Errorf("%w: %s SHA-256 differs from immutable receipt", ErrArtifactIntegrity, check.name)
		}
	}
	if !utf8.Valid(htmlBytes) || !utf8.Valid(textBytes) {
		return loadedArtifact{}, fmt.Errorf("%w: text representation is not UTF-8", ErrArtifactIntegrity)
	}
	if err := validateSyntheticRecipients(mimeBytes); err != nil {
		return loadedArtifact{}, err
	}

	var receipt campaigncompiler.Receipt
	if len(artifact.CompilerReceipt) > campaignchecks.MaxReceiptJSONBytes || decodeStrict(artifact.CompilerReceipt, &receipt) != nil {
		return loadedArtifact{}, fmt.Errorf("%w: compiler receipt cannot be strictly decoded", ErrArtifactIntegrity)
	}
	var manifest campaigncompiler.RepresentationManifest
	if len(artifact.RepresentationManifest) > campaignchecks.MaxReceiptJSONBytes || decodeStrict(artifact.RepresentationManifest, &manifest) != nil {
		return loadedArtifact{}, fmt.Errorf("%w: representation manifest cannot be strictly decoded", ErrArtifactIntegrity)
	}
	if receipt.SourceHash != frozen.revision.SourceHash || receipt.CompilerVersion != frozen.plan.CompilerVersion ||
		manifest.OutboundMIMESHA256 != artifact.OutboundMIMEHash || manifest.HTMLSHA256 != artifact.HTMLHash ||
		manifest.TextSHA256 != artifact.TextHash || manifest.MIMEStructureSHA256 != artifact.MIMEStructureHash ||
		manifest.Locale != artifact.Locale || !equalStrings(nodeIDs(receipt.IncludedNodeIDs), scenario.IncludedNodeIDs) {
		return loadedArtifact{}, fmt.Errorf("%w: compiler receipts differ from frozen identities", ErrArtifactIntegrity)
	}

	structured, scripts, err := extractStructuredData(htmlBytes)
	if err != nil {
		return loadedArtifact{}, fmt.Errorf("%w: structured data scan failed", ErrArtifactIntegrity)
	}
	if artifact.StructuredDataHash != "" {
		if scripts != 1 || digestBytes(structured) != artifact.StructuredDataHash ||
			manifest.StructuredDataSHA256 != artifact.StructuredDataHash || !manifest.StructuredDataPresent {
			return loadedArtifact{}, fmt.Errorf("%w: structured data differs from immutable receipt", ErrArtifactIntegrity)
		}
	} else if manifest.StructuredDataSHA256 != "" {
		return loadedArtifact{}, fmt.Errorf("%w: structured data hash identities disagree", ErrArtifactIntegrity)
	}

	effectiveRevision, documentHash, err := effectiveRevisionForArtifact(frozen.revision, *artifact)
	if err != nil {
		return loadedArtifact{}, err
	}
	if effectiveRevision.SourceMode == campaignartifact.SourceModeSemantic &&
		(receipt.SemanticDocumentSHA256 != documentHash || manifest.SemanticDocumentSHA256 != documentHash) {
		return loadedArtifact{}, fmt.Errorf("%w: effective semantic document hash differs", ErrArtifactIntegrity)
	}

	artifactInput := artifact.ArtifactInput
	compilation := campaigncompiler.Result{
		Subject: effectiveRevision.Subject, HTML: string(htmlBytes), Text: string(textBytes),
		StructuredData: append(json.RawMessage(nil), structured...), RFC822: append([]byte(nil), mimeBytes...),
		Receipt: receipt, RepresentationManifest: manifest, Artifact: artifactInput,
	}
	return loadedArtifact{artifact: *artifact, revision: effectiveRevision, compilation: compilation}, nil
}

func (w *Worker) readObject(ctx context.Context, tenantID, reference, expectedRest, expectedMediaType string, maximum int64) ([]byte, error) {
	rest, err := campaignmaterializer.ParseObjectReference(reference)
	if err != nil || rest != expectedRest {
		return nil, fmt.Errorf("%w: invalid tenant-relative object reference", ErrArtifactIntegrity)
	}
	body, contentType, err := w.Objects.Get(ctx, tenantID, rest)
	if err != nil {
		return nil, classifyArtifactRead("object", err)
	}
	if body == nil {
		return nil, fmt.Errorf("%w: object store returned a nil body", ErrArtifactIntegrity)
	}
	mediaType, parameters, parseErr := mime.ParseMediaType(strings.TrimSpace(contentType))
	if parseErr != nil || !strings.EqualFold(mediaType, expectedMediaType) {
		_ = body.Close()
		return nil, fmt.Errorf("%w: expected %s", ErrObjectMediaType, expectedMediaType)
	}
	if expectedMediaType == "text/html" || expectedMediaType == "text/plain" {
		if charset := strings.ToLower(strings.TrimSpace(parameters["charset"])); charset != "" && charset != "utf-8" {
			_ = body.Close()
			return nil, fmt.Errorf("%w: text artifact charset is not UTF-8", ErrObjectMediaType)
		}
	}
	value, readErr := io.ReadAll(io.LimitReader(body, maximum+1))
	closeErr := body.Close()
	if readErr != nil {
		return nil, fmt.Errorf("read internal object: %w", readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close internal object: %w", closeErr)
	}
	if int64(len(value)) > maximum {
		return nil, ErrObjectTooLarge
	}
	return value, nil
}

func effectiveRevisionForArtifact(revision campaignartifact.Revision, artifact campaignartifact.Artifact) (campaignartifact.Revision, string, error) {
	if revision.SourceMode != campaignartifact.SourceModeSemantic {
		if artifact.VariantID != "" {
			return campaignartifact.Revision{}, "", fmt.Errorf("%w: legacy artifact cannot select a semantic variant", ErrArtifactIntegrity)
		}
		return revision, "", nil
	}
	document, subject, err := effectiveDocument(revision, artifact)
	if err != nil {
		return campaignartifact.Revision{}, "", err
	}
	normalized, diagnostics := semanticemail.NormalizeAndValidateV2(document)
	if diagnostics.HasErrors() {
		return campaignartifact.Revision{}, "", fmt.Errorf("%w: effective semantic document is invalid", ErrArtifactIntegrity)
	}
	encodedDocument, err := json.Marshal(normalized)
	if err != nil {
		return campaignartifact.Revision{}, "", fmt.Errorf("%w: encode effective semantic document", ErrArtifactIntegrity)
	}
	encodedNodes, err := json.Marshal(normalized.Nodes)
	if err != nil {
		return campaignartifact.Revision{}, "", fmt.Errorf("%w: encode effective semantic nodes", ErrArtifactIntegrity)
	}
	revision.Subject = subject
	revision.SemanticTree = encodedNodes
	return revision, digestBytes(encodedDocument), nil
}

func effectiveDocument(revision campaignartifact.Revision, artifact campaignartifact.Artifact) (semanticemail.DocumentV2, string, error) {
	if artifact.VariantID != "" {
		if len(revision.Variants) > campaigncoverage.MaxManifestBytes*2 {
			return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: reviewed variants exceed bound", ErrObjectTooLarge)
		}
		var variants []reviewedVariant
		if err := decodeStrict(revision.Variants, &variants); err != nil {
			return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: reviewed variants cannot be strictly decoded", ErrArtifactIntegrity)
		}
		for _, variant := range variants {
			if variant.ID != artifact.VariantID {
				continue
			}
			if variant.AdapterVersion != reviewedVariantAdapterVersion || strings.TrimSpace(variant.Subject) == "" {
				return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: reviewed variant adapter identity is unsupported", ErrArtifactIntegrity)
			}
			return variant.Document, variant.Subject, nil
		}
		return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: artifact variant is absent from frozen revision", ErrArtifactIntegrity)
	}
	var nodes []semanticemail.Node
	if err := decodeStrict(revision.SemanticTree, &nodes); err != nil {
		return semanticemail.DocumentV2{}, "", fmt.Errorf("%w: base semantic nodes cannot be strictly decoded", ErrArtifactIntegrity)
	}
	languageTag, err := frozenLanguage(revision, artifact.Locale)
	if err != nil {
		return semanticemail.DocumentV2{}, "", err
	}
	return semanticemail.DocumentV2{
		SchemaVersion: semanticemail.SchemaVersionV2,
		Language:      languageTag, Direction: semanticemail.DirectionAuto, Nodes: nodes,
	}, revision.Subject, nil
}

func frozenLanguage(revision campaignartifact.Revision, fallback string) (string, error) {
	trimmed := bytes.TrimSpace(revision.FactContract)
	if len(trimmed) != 0 && !bytes.Equal(trimmed, []byte(`{}`)) {
		var contract factcontract.ContractV1
		if err := decodeStrict(trimmed, &contract); err != nil {
			return "", fmt.Errorf("%w: fact contract cannot be strictly decoded", ErrArtifactIntegrity)
		}
		if value := strings.TrimSpace(string(contract.Language)); value != "" {
			return value, nil
		}
	}
	var locales []string
	if len(bytes.TrimSpace(revision.Locales)) != 0 {
		if err := decodeStrict(revision.Locales, &locales); err != nil {
			return "", fmt.Errorf("%w: frozen locales cannot be strictly decoded", ErrArtifactIntegrity)
		}
	}
	canonical := make([]string, 0, len(locales))
	for _, locale := range locales {
		tag, err := language.Parse(strings.TrimSpace(locale))
		if err != nil || tag == language.Und {
			return "", fmt.Errorf("%w: frozen locale is invalid", ErrArtifactIntegrity)
		}
		canonical = append(canonical, tag.String())
	}
	if len(canonical) != 0 {
		sort.Strings(canonical)
		return canonical[0], nil
	}
	tag, err := language.Parse(strings.TrimSpace(fallback))
	if err != nil || tag == language.Und {
		return "", fmt.Errorf("%w: scenario locale is invalid", ErrArtifactIntegrity)
	}
	return tag.String(), nil
}

func extractStructuredData(source []byte) (json.RawMessage, int, error) {
	tokenizer := html.NewTokenizer(bytes.NewReader(source))
	var payloads [][]byte
	inStructured := false
	var current bytes.Buffer
	for {
		switch tokenizer.Next() {
		case html.ErrorToken:
			if errors.Is(tokenizer.Err(), io.EOF) {
				if inStructured {
					return nil, 0, errors.New("unterminated structured-data script")
				}
				if len(payloads) == 0 {
					return nil, 0, nil
				}
				return bytes.Join(payloads, []byte("\n")), len(payloads), nil
			}
			return nil, 0, tokenizer.Err()
		case html.StartTagToken:
			token := tokenizer.Token()
			if strings.EqualFold(token.Data, "script") {
				for _, attribute := range token.Attr {
					if strings.EqualFold(attribute.Key, "type") && strings.EqualFold(strings.TrimSpace(attribute.Val), "application/ld+json") {
						if inStructured {
							return nil, 0, errors.New("nested structured-data script")
						}
						inStructured = true
						current.Reset()
					}
				}
			}
		case html.TextToken:
			if inStructured {
				current.Write(tokenizer.Raw())
			}
		case html.EndTagToken:
			token := tokenizer.Token()
			if inStructured && strings.EqualFold(token.Data, "script") {
				payloads = append(payloads, append([]byte(nil), current.Bytes()...))
				inStructured = false
			}
		}
	}
}

func validateSyntheticRecipients(raw []byte) error {
	message, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("%w: MIME headers cannot be parsed", ErrArtifactIntegrity)
	}
	found := false
	for _, header := range []string{"To", "Cc", "Bcc", "Resent-To", "Resent-Cc", "Resent-Bcc"} {
		value := strings.TrimSpace(message.Header.Get(header))
		if value == "" {
			continue
		}
		addresses, err := mail.ParseAddressList(value)
		if err != nil {
			return fmt.Errorf("%w: recipient header is malformed", ErrSyntheticOnly)
		}
		for _, address := range addresses {
			found = true
			at := strings.LastIndexByte(address.Address, '@')
			if at < 1 || !reservedExampleDomain(address.Address[at+1:]) {
				return ErrSyntheticOnly
			}
		}
	}
	if !found {
		return fmt.Errorf("%w: MIME contains no synthetic recipient", ErrSyntheticOnly)
	}
	return nil
}

func reservedExampleDomain(value string) bool {
	domain := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
	if domain == "example.com" || domain == "example.net" || domain == "example.org" || domain == "localhost" {
		return true
	}
	for _, suffix := range []string{".test", ".example", ".invalid", ".localhost"} {
		if strings.HasSuffix(domain, suffix) {
			return true
		}
	}
	return domain == "test" || domain == "example" || domain == "invalid"
}

func classifyArtifactRead(kind string, err error) error {
	if errors.Is(err, campaignartifact.ErrNotFound) || errors.Is(err, campaignartifact.ErrInvalidInput) {
		return fmt.Errorf("%w: %s is absent", ErrArtifactIntegrity, kind)
	}
	return fmt.Errorf("read %s: %w", kind, err)
}

func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON data")
	}
	return nil
}

func canonicalJSONObject(raw []byte, maximum int) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maximum {
		return nil, errors.New("JSON object is absent or over limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if _, ok := value.(map[string]any); !ok {
		return nil, errors.New("JSON object required")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON data")
	}
	return json.Marshal(value)
}

func revisionSize(revision campaignartifact.Revision) int {
	return len(revision.Subject) + len(revision.SemanticTree) + len(revision.FactContract) +
		len(revision.Variants) + len(revision.Locales) + pointerStringLength(revision.LegacyHTML) +
		pointerStringLength(revision.ReviewedPlainText)
}

func pointerStringLength(value *string) int {
	if value == nil {
		return 0
	}
	return len(*value)
}

func nodeIDs(input []semanticemail.NodeID) []string {
	result := make([]string, len(input))
	for index, value := range input {
		result[index] = string(value)
	}
	return result
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func digestBytes(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
