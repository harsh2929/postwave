// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

var designUnitTestActor = ReferenceReviewActor{
	Type: "service",
	ID:   "design-unit-test",
}

func TestNormalizeCreateDesignDraftInputCanonicalizesGovernedReferences(t *testing.T) {
	source := "11111111-1111-4111-8111-111111111111"
	additional := "22222222-2222-4222-8222-222222222222"
	input, references, err := normalizeCreateDesignDraftInput(CreateDesignDraftInput{
		Mode: " ADAPT ", SourceTemplateID: strings.ToUpper(source),
		Fidelity:             " CLOSE ",
		ReferenceTemplateIDs: []string{source, additional, additional},
		Sections:             []string{" Hero ", "Stories"},
	})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if input.Mode != "adapt" || input.Fidelity != "close" ||
		input.SourceTemplateID != source {
		t.Fatalf("normalized input = %#v", input)
	}
	if got, want := strings.Join(references, ","), source+","+additional; got != want {
		t.Fatalf("references = %q, want %q", got, want)
	}
	if len(input.ReferenceTemplateIDs) != 1 ||
		input.ReferenceTemplateIDs[0] != additional {
		t.Fatalf("additional references = %#v", input.ReferenceTemplateIDs)
	}
	if got := strings.Join(input.Sections, ","); got != "Hero,Stories" {
		t.Fatalf("sections = %q", got)
	}
}

func TestNormalizeCreateDesignDraftInputRejectsAmbiguousOrOversizedDirection(t *testing.T) {
	validSource := "11111111-1111-4111-8111-111111111111"
	tests := []CreateDesignDraftInput{
		{Mode: "generate"},
		{Mode: "adapt", SourceTemplateID: "not-a-uuid"},
		{Mode: "generate", Brief: "ok", SourceTemplateID: validSource},
		{Mode: "generate", Brief: "ok", Fidelity: "pixel-perfect-copy"},
		{Mode: "generate", Brief: strings.Repeat("x", 8001)},
	}
	for index, input := range tests {
		if _, _, err := normalizeCreateDesignDraftInput(input); !errors.Is(err, ErrDesignDraftInvalid) {
			t.Errorf("case %d err = %v, want ErrDesignDraftInvalid", index, err)
		}
	}
}

func TestGeneratedDesignValidationRepairsActiveContentAndReportsReviewChecks(t *testing.T) {
	generated, validation, warnings, err := repairAndValidateGeneratedDesign(
		context.Background(),
		GeneratedDesign{
			Name: "Digest", Subject: "",
			BodyHTML: `<html><body onload="steal()"><script>steal()</script>` +
				`<img src="https://images.example/hero.png">` +
				`<a href="javascript:steal()">Bad link</a></body></html>`,
		},
		"Fallback name", "Fallback subject",
	)
	if err != nil {
		t.Fatalf("repairAndValidateGeneratedDesign: %v", err)
	}
	lower := strings.ToLower(generated.BodyHTML)
	for _, forbidden := range []string{"<script", "onload=", "javascript:"} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("sanitized body retained %q: %s", forbidden, generated.BodyHTML)
		}
	}
	if generated.Subject != "Fallback subject" {
		t.Fatalf("subject = %q", generated.Subject)
	}
	if validation.Status != "warn" || len(validation.Checks) < 5 {
		t.Fatalf("validation = %#v", validation)
	}
	codes := map[string]bool{}
	for _, warning := range warnings {
		codes[warning.Code] = true
	}
	for _, code := range []string{"subject_repaired", "active_content_removed", "image_alt_text_missing"} {
		if !codes[code] {
			t.Errorf("warnings missing %q: %#v", code, warnings)
		}
	}
}

func TestGeneratedDesignValidationDropsUnsafeMJMLExecutionSource(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("APP_ENV", "test")
	generated, validation, warnings, err := repairAndValidateGeneratedDesign(
		context.Background(),
		GeneratedDesign{
			Name: "Digest", Subject: "This week",
			BodyHTML: `<html><head><meta name="viewport" content="width=device-width"></head>` +
				`<body><a href="https://example.test">Read</a></body></html>`,
			BodyMJML: `<mjml><mj-body><mj-section><mj-column><mj-text>` +
				`<script>steal()</script><a href="https://example.test">Read</a>` +
				`</mj-text></mj-column></mj-section></mj-body></mjml>`,
		},
		"", "",
	)
	if err != nil {
		t.Fatalf("repairAndValidateGeneratedDesign: %v", err)
	}
	if generated.BodyMJML != "" {
		t.Fatalf("unsafe executable MJML survived review: %s", generated.BodyMJML)
	}
	if strings.Contains(strings.ToLower(generated.BodyHTML), "<script") {
		t.Fatalf("safe HTML contains script: %s", generated.BodyHTML)
	}
	foundCheck, foundWarning := false, false
	for _, check := range validation.Checks {
		if check.Code == "mjml_source_safety" && check.Repaired {
			foundCheck = true
		}
	}
	for _, warning := range warnings {
		if warning.Code == "mjml_downgraded_to_html" {
			foundWarning = true
		}
	}
	if !foundCheck || !foundWarning {
		t.Fatalf("validation=%#v warnings=%#v", validation, warnings)
	}
}

func TestGeneratedDesignValidationRemovesExecutableCSSAndURLSchemes(t *testing.T) {
	generated, _, warnings, err := repairAndValidateGeneratedDesign(
		context.Background(),
		GeneratedDesign{
			Name: "Digest", Subject: "This week", PreviewText: "A safe summary.",
			BodyHTML: `<html><head><meta name="viewport" content="width=device-width">` +
				`<style>p{width:expression(steal())}</style></head><body>` +
				`<p style="background:url(data:image/svg+xml;base64,PHN2Zz4=)">Hello</p>` +
				`<img src="file:///etc/passwd" alt="Story image">` +
				`<footer><a href="{{unsubscribe_url}}">Unsubscribe</a></footer>` +
				`</body></html>`,
		},
		"", "",
	)
	if err != nil {
		t.Fatalf("repairAndValidateGeneratedDesign: %v", err)
	}
	lower := strings.ToLower(generated.BodyHTML)
	for _, forbidden := range []string{
		"expression(", "data:image/svg", "file:///etc/passwd",
	} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("sanitized body retained %q: %s", forbidden, generated.BodyHTML)
		}
	}
	found := false
	for _, warning := range warnings {
		if warning.Code == "active_content_removed" {
			found = true
		}
	}
	if !found {
		t.Fatalf("warnings missing active-content repair: %#v", warnings)
	}
}

func TestGeneratedDesignValidationCoversSendAccessibilityAndComplianceEdges(t *testing.T) {
	generated, validation, warnings, err := repairAndValidateGeneratedDesign(
		context.Background(),
		GeneratedDesign{
			Name: "Accessible digest", Subject: "This week",
			PreviewText: "The stories worth your time.",
			BodyHTML: `<html><head><meta name="viewport" content="width=device-width"></head>` +
				`<body>` +
				`<p style="color:#777777;background-color:#888888">Hard to read</p>` +
				`<img src="https://images.example/hero.png" alt="">` +
				`<a href="/relative-story">Broken destination</a>` +
				`<footer><a href="{{unsubscribe_url}}">Unsubscribe</a></footer>` +
				`</body></html>`,
		},
		"", "",
	)
	if err != nil {
		t.Fatalf("repairAndValidateGeneratedDesign: %v", err)
	}
	checkStatus := map[string]string{}
	for _, check := range validation.Checks {
		checkStatus[check.Code] = check.Status
	}
	for code, want := range map[string]string{
		"image_alt_text":    "warn",
		"link_validity":     "warn",
		"unsubscribe_link":  "pass",
		"compliance_footer": "pass",
		"color_contrast":    "warn",
		"inbox_clip_risk":   "pass",
	} {
		if checkStatus[code] != want {
			t.Errorf("%s = %q, want %q; checks=%#v",
				code, checkStatus[code], want, validation.Checks)
		}
	}
	warningCodes := map[string]bool{}
	for _, warning := range warnings {
		warningCodes[warning.Code] = true
	}
	for _, code := range []string{
		"image_alt_text_missing", "invalid_links", "color_contrast_review",
	} {
		if !warningCodes[code] {
			t.Errorf("warnings missing %q: %#v", code, warnings)
		}
	}
	if warningCodes["unsubscribe_link_missing"] ||
		warningCodes["compliance_footer_missing"] {
		t.Fatalf("compliant footer was not recognized: %#v", warnings)
	}
	if generated.BodyHTML == "" {
		t.Fatal("validated HTML is empty")
	}
}

func TestGeneratedDesignValidationOnlyPassesTheUnsubscribePlaceholder(t *testing.T) {
	// The compliance gate refuses to send a body whose unsubscribe link is
	// not the per-recipient placeholder, so design validation must not call
	// a fixed link, or footer text with no link, a pass.
	for name, footer := range map[string]string{
		"fixed link":         `<footer><a href="https://example.com/unsubscribe">Unsubscribe</a></footer>`,
		"preference wording": `<footer><a href="https://example.com/prefs">Manage preferences</a></footer>`,
		"text only":          `<footer><p>To unsubscribe, reply STOP. Email preferences live in your account.</p></footer>`,
	} {
		t.Run(name, func(t *testing.T) {
			_, validation, warnings, err := repairAndValidateGeneratedDesign(context.Background(), GeneratedDesign{
				Name: "Digest", Subject: "This week", PreviewText: "The stories worth your time.",
				BodyHTML: `<html><body><p>Hello</p>` + footer + `</body></html>`,
			}, "", "")
			if err != nil {
				t.Fatalf("repairAndValidateGeneratedDesign: %v", err)
			}
			for _, check := range validation.Checks {
				if check.Code != "unsubscribe_link" {
					continue
				}
				if check.Status != "warn" {
					t.Fatalf("unsubscribe_link = %q (%s), want warn", check.Status, check.Message)
				}
				if strings.Contains(check.Message, "Moosewave") || strings.Contains(check.Message, "append") {
					t.Fatalf("check message names the brand or promises a footer nothing appends: %q", check.Message)
				}
				if !strings.Contains(check.Message, "{{ unsubscribe_url }}") {
					t.Fatalf("check message does not say what to add: %q", check.Message)
				}
			}
			missing := false
			for _, warning := range warnings {
				missing = missing || warning.Code == "unsubscribe_link_missing"
			}
			if !missing {
				t.Fatalf("warnings = %#v, want unsubscribe_link_missing", warnings)
			}
		})
	}
}

type designCommitStoreStub struct {
	DesignDraftStore
	draft            *DesignDraft
	markedTemplateID string
	markedCampaignID string
	markedRevision   int
}

type designMutationRegistrarStub struct {
	DesignDraftStore
	draftID      string
	operation    string
	keyHash      []byte
	requestHash  []byte
	replayed     bool
	registration error
}

func (store *designMutationRegistrarStub) RegisterDesignMutation(
	_ context.Context,
	_ string,
	_ ReferenceReviewActor,
	draftID, operation string,
	keyHash, requestHash []byte,
) (designMutationRegistration, error) {
	store.draftID = draftID
	store.operation = operation
	store.keyHash = append([]byte(nil), keyHash...)
	store.requestHash = append([]byte(nil), requestHash...)
	return designMutationRegistration{Replayed: store.replayed}, store.registration
}

func TestRegisterDesignMutationBindsExactRequestIdentity(t *testing.T) {
	store := &designMutationRegistrarStub{replayed: true}
	deps := &Deps{Designs: store}
	replayed, err := deps.registerDesignMutation(
		context.Background(), "tenant-1", designUnitTestActor,
		"draft-1", "refine", "stable-key",
		RefineDesignDraftInput{Instructions: "More visual rhythm", BaseRevision: 2},
	)
	if err != nil {
		t.Fatalf("registerDesignMutation: %v", err)
	}
	if !replayed.Replayed || store.draftID != "draft-1" ||
		store.operation != "refine" ||
		len(store.keyHash) != 32 || len(store.requestHash) != 32 {
		t.Fatalf("registration=%#v replayed=%v", store, replayed)
	}
}

func (store *designCommitStoreStub) Get(
	context.Context, string, ReferenceReviewActor, string,
) (*DesignDraft, error) {
	return store.draft, nil
}

func (store *designCommitStoreStub) MarkSaved(
	_ context.Context,
	_ string,
	_ ReferenceReviewActor,
	_ string,
	revision int,
	templateID string,
) (*DesignDraft, error) {
	store.markedRevision, store.markedTemplateID = revision, templateID
	return store.draft, nil
}

func (store *designCommitStoreStub) MarkCampaignCreated(
	_ context.Context,
	_ string,
	_ ReferenceReviewActor,
	_ string,
	revision int,
	campaignID string,
) (*DesignDraft, error) {
	store.markedRevision, store.markedCampaignID = revision, campaignID
	return store.draft, nil
}

func readyDesignDraftForCommit() *DesignDraft {
	hash := strings.Repeat("a", 64)
	return &DesignDraft{
		ID:                   "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		Status:               designDraftStatusReady,
		CurrentRevision:      1,
		ReferenceTemplateIDs: []string{},
		RequestPayload: CreateDesignDraftInput{
			Mode: "generate", Brief: "Digest", Goal: "newsletter",
		},
		Revision: &DesignRevision{
			Revision:   1,
			OutputHash: hash,
			Output: DesignResponse{
				Name: "Digest", Subject: "This week",
				BodyHTML:             `<html><body><p>Safe reviewed body</p></body></html>`,
				Variables:            map[string]any{},
				ReferenceTemplateIDs: []string{},
			},
		},
	}
}

func TestSaveDesignDraftRecoversCommittedTemplateAndConvergesMarker(t *testing.T) {
	draft := readyDesignDraftForCommit()
	store := &designCommitStoreStub{draft: draft}
	createCalls := 0
	repo := &templateRepositoryStub{
		createFn: func(context.Context, string, CreateInput) (*Template, error) {
			createCalls++
			return nil, errors.New("must not insert duplicate")
		},
		getByDesignDraftFn: func(
			context.Context, string, string,
		) (*Template, error) {
			return &Template{
				ID: "template-existing", Slug: "reviewed-digest",
				Name: "Digest", Subject: "This week",
				BodyHTML: `<html><body><p>Safe reviewed body</p></body></html>`,
				Category: "newsletter", Goal: "newsletter",
				Variables:    []map[string]interface{}{},
				TemplateKind: templateKindEditable, SourceProvider: "postwave",
				SourceLicenseStatus:  licenseStatusOwned,
				ReviewStatus:         reviewStatusApproved,
				QualityScore:         0.75,
				ReferenceTemplateIDs: []string{},
				GenerationMetadata: map[string]any{
					"design_draft_id":          draft.ID,
					"design_draft_revision":    float64(1),
					"design_draft_output_hash": draft.Revision.OutputHash,
				},
			}, nil
		},
	}
	deps := &Deps{Designs: store, Repo: repo}
	template, err := deps.SaveDesignDraftRevision(
		context.Background(),
		"tenant-1",
		designUnitTestActor,
		draft.ID,
		SaveDesignDraftInput{
			CommitDesignDraftInput: CommitDesignDraftInput{
				Revision: 1, OutputHash: draft.Revision.OutputHash,
			},
			Slug: "reviewed-digest",
		},
	)
	if err != nil {
		t.Fatalf("SaveDesignDraftRevision: %v", err)
	}
	if template.ID != "template-existing" || createCalls != 0 ||
		store.markedTemplateID != template.ID || store.markedRevision != 1 {
		t.Fatalf("template=%#v creates=%d marker=%q/%d",
			template, createCalls, store.markedTemplateID, store.markedRevision)
	}
}

func TestDesignDraftProjectionKeepsIndependentCommitActions(t *testing.T) {
	revision := 1
	tests := []struct {
		name               string
		draft              DesignDraft
		wantSave           bool
		wantCreateCampaign bool
		wantAction         string
	}{
		{
			name: "saved template can still become a campaign",
			draft: DesignDraft{
				Status: designDraftStatusSaved, SavedTemplateID: "template-1",
				SavedRevision: &revision,
			},
			wantCreateCampaign: true,
			wantAction:         "use_saved_campaign_template",
		},
		{
			name: "campaign output can still be saved for reuse",
			draft: DesignDraft{
				Status:            designDraftStatusCampaignCreated,
				CreatedCampaignID: "campaign-1", CampaignRevision: &revision,
			},
			wantSave:   true,
			wantAction: "open_campaign_draft",
		},
		{
			name: "both commits expose neither duplicate action",
			draft: DesignDraft{
				Status: designDraftStatusSaved, SavedTemplateID: "template-1",
				SavedRevision: &revision, CreatedCampaignID: "campaign-1",
				CampaignRevision: &revision,
			},
			wantAction: "open_campaign_draft",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			projectDesignDraft(&test.draft)
			if test.draft.Capabilities.CanSave != test.wantSave ||
				test.draft.Capabilities.CanCreateCampaign != test.wantCreateCampaign ||
				test.draft.RecommendedAction != test.wantAction {
				t.Fatalf("projection = capabilities=%#v action=%q",
					test.draft.Capabilities, test.draft.RecommendedAction)
			}
		})
	}
}

func TestDesignCommitRecoveryRejectsDifferentImmutableRevision(t *testing.T) {
	draft := readyDesignDraftForCommit()
	store := &designCommitStoreStub{draft: draft}
	deps := &Deps{
		Designs: store,
		Repo: &templateRepositoryStub{getByDesignDraftFn: func(
			context.Context, string, string,
		) (*Template, error) {
			return &Template{
				ID: "template-from-another-revision",
				GenerationMetadata: map[string]any{
					"design_draft_revision":    2,
					"design_draft_output_hash": strings.Repeat("b", 64),
				},
			}, nil
		}},
		Campaigns: &designCampaignRecoveryStub{existing: &campaigns.Campaign{
			ID:                             "campaign-from-another-revision",
			SourceTemplateDesignDraftID:    draft.ID,
			SourceTemplateDesignRevision:   2,
			SourceTemplateDesignOutputHash: strings.Repeat("b", 64),
		}},
	}
	if recovered, err := deps.recoverSavedTemplate(
		context.Background(), "tenant-1", designUnitTestActor,
		draft, draft.Revision, CreateInput{},
	); !errors.Is(err, ErrDesignDraftOutcomeConflict) || recovered != nil {
		t.Fatalf("template recovery = %#v, %v; want outcome conflict", recovered, err)
	}
	if recovered, err := deps.recoverCreatedCampaign(
		context.Background(), "tenant-1", designUnitTestActor,
		draft, draft.Revision, campaigns.CreateInput{},
	); !errors.Is(err, ErrDesignDraftOutcomeConflict) || recovered != nil {
		t.Fatalf("campaign recovery = %#v, %v; want outcome conflict", recovered, err)
	}
	if store.markedTemplateID != "" || store.markedCampaignID != "" {
		t.Fatalf("mismatched lineage advanced marker: %#v", store)
	}
}

type designCampaignRecoveryStub struct {
	createdInput campaigns.CreateInput
	existing     *campaigns.Campaign
}

func (stub *designCampaignRecoveryStub) Create(
	_ context.Context,
	_ string,
	input campaigns.CreateInput,
) (*campaigns.Campaign, error) {
	stub.createdInput = input
	return &campaigns.Campaign{ID: "campaign-created"}, nil
}

func (stub *designCampaignRecoveryStub) GetByTemplateDesignDraft(
	context.Context, string, string,
) (*campaigns.Campaign, error) {
	if stub.existing == nil {
		return nil, campaigns.ErrNotFound
	}
	return stub.existing, nil
}

func TestCreateCampaignFromDesignBindsImmutableLineage(t *testing.T) {
	draft := readyDesignDraftForCommit()
	store := &designCommitStoreStub{draft: draft}
	campaignsRepo := &designCampaignRecoveryStub{}
	deps := &Deps{
		Designs: store, Repo: &templateRepositoryStub{},
		Campaigns: campaignsRepo,
	}
	campaign, err := deps.CreateCampaignFromDesignRevision(
		context.Background(),
		"tenant-1",
		designUnitTestActor,
		draft.ID,
		CreateCampaignFromDesignDraftInput{
			CommitDesignDraftInput: CommitDesignDraftInput{
				Revision: 1, OutputHash: draft.Revision.OutputHash,
			},
		},
	)
	if err != nil {
		t.Fatalf("CreateCampaignFromDesignRevision: %v", err)
	}
	if campaign.ID != "campaign-created" ||
		campaignsRepo.createdInput.SourceTemplateDesignDraftID != draft.ID ||
		campaignsRepo.createdInput.SourceTemplateDesignRevision != 1 ||
		campaignsRepo.createdInput.SourceTemplateDesignOutputHash != draft.Revision.OutputHash ||
		store.markedCampaignID != campaign.ID {
		t.Fatalf("campaign=%#v input=%#v marker=%q",
			campaign, campaignsRepo.createdInput, store.markedCampaignID)
	}
}

type designDraftWorkerStoreStub struct {
	DesignDraftStore
	claim       *claimedDesignDraft
	completed   bool
	failed      bool
	failureCode string
	retryable   bool
	output      DesignResponse
	validation  DesignValidation
	warnings    []TemplateWarning
}

func (store *designDraftWorkerStoreStub) ClaimNext(context.Context) (*claimedDesignDraft, error) {
	claim := store.claim
	store.claim = nil
	return claim, nil
}

func (store *designDraftWorkerStoreStub) Complete(
	_ context.Context,
	_ claimedDesignDraft,
	output DesignResponse,
	validation DesignValidation,
	warnings []TemplateWarning,
) (*DesignDraft, error) {
	store.completed = true
	store.output = output
	store.validation = validation
	store.warnings = warnings
	return &DesignDraft{Status: designDraftStatusReady}, nil
}

func (store *designDraftWorkerStoreStub) Fail(
	_ context.Context,
	_ claimedDesignDraft,
	code, _ string,
	retryable bool,
) error {
	store.failed = true
	store.failureCode = code
	store.retryable = retryable
	return nil
}

type fixedDesignGenerator struct {
	result GeneratedDesign
	err    error
	calls  int
}

func (generator *fixedDesignGenerator) GenerateTemplate(
	context.Context,
	string,
	GenerateDesignRequest,
) (GeneratedDesign, error) {
	generator.calls++
	return generator.result, generator.err
}

func TestDesignDraftWorkerCompletesSafeImmutableOutput(t *testing.T) {
	referenceID := "11111111-1111-4111-8111-111111111111"
	store := &designDraftWorkerStoreStub{claim: &claimedDesignDraft{Draft: DesignDraft{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenantID: "tenant-1",
		Mode: designDraftModeGenerate, Status: designDraftStatusGenerating,
		ReferenceTemplateIDs: []string{referenceID},
		RequestPayload: CreateDesignDraftInput{
			Mode: designDraftModeGenerate, Brief: "Founder digest",
			PreviewText:          "The founder stories worth reading this week.",
			ReferenceTemplateIDs: []string{referenceID},
		},
		pendingOperation: "initial", claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	}}}
	repo := &templateRepositoryStub{getFn: func(context.Context, string, string) (*Template, error) {
		return &Template{
			ID: referenceID, TemplateKind: templateKindReference,
			ReviewStatus:               reviewStatusApproved,
			ReferenceAdaptationAllowed: true,
			SourceLicenseStatus:        licenseStatusUnreviewed,
		}, nil
	}}
	generator := &fixedDesignGenerator{result: GeneratedDesign{
		Name: "Founder digest", Subject: "This week",
		BodyHTML: `<html><head><meta name="viewport" content="width=device-width"></head>` +
			`<body><a href="https://example.com">Read</a>` +
			`<footer><a href="{{unsubscribe_url}}">Unsubscribe</a></footer>` +
			`</body></html>`,
	}}
	worker := &DesignDraftWorker{Store: store, Templates: repo, Generator: generator}
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if !processed || !store.completed || store.failed {
		t.Fatalf("processed=%v completed=%v failed=%v", processed, store.completed, store.failed)
	}
	if store.output.Name != "Founder digest" ||
		store.output.ReferenceTemplateIDs[0] != referenceID ||
		store.validation.Status != "pass" {
		t.Fatalf("output=%#v validation=%#v", store.output, store.validation)
	}
}

func TestDesignDraftWorkerClassifiesTransientGeneratorFailureForRetry(t *testing.T) {
	store := &designDraftWorkerStoreStub{claim: &claimedDesignDraft{Draft: DesignDraft{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenantID: "tenant-1",
		Mode: designDraftModeGenerate, Status: designDraftStatusGenerating,
		RequestPayload: CreateDesignDraftInput{
			Mode: designDraftModeGenerate, Brief: "Digest",
		},
		pendingOperation: "initial", claimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	}}}
	worker := &DesignDraftWorker{
		Store: store, Templates: &templateRepositoryStub{},
		Generator: &fixedDesignGenerator{err: ErrGeneratorUnavailable},
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if !processed || !store.failed || store.failureCode != "generator_unavailable" || !store.retryable {
		t.Fatalf("failure state = %#v", store)
	}
}

func TestCreateDesignDraftRequiresIdempotencyBeforeEnqueue(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/campaign-template-designs",
		strings.NewReader(`{"mode":"generate","brief":"Digest"}`))
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(
		request.Context(), &middleware.Tenant{ID: "tenant-1"},
	))
	request = request.WithContext(middleware.WithUser(
		request.Context(),
		&middleware.User{ID: "design-user", TenantID: "tenant-1"},
	))
	response := httptest.NewRecorder()
	(&Deps{Designs: &designDraftWorkerStoreStub{}, Repo: &templateRepositoryStub{}}).
		CreateDesignDraft(response, request)
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "idempotency_key_required") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestCreateDesignDraftFailsBeforeQueueWhenVoiceIsDisabled(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/v1/campaign-template-designs",
		strings.NewReader(`{"mode":"generate","brief":"A weekly digest"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "disabled-provider-test")
	request = request.WithContext(middleware.WithTenant(request.Context(),
		&middleware.Tenant{ID: "tenant-1"}))
	request = request.WithContext(middleware.WithUser(request.Context(),
		&middleware.User{ID: "design-user", TenantID: "tenant-1"}))
	response := httptest.NewRecorder()
	(&Deps{
		Designs:   &designDraftWorkerStoreStub{},
		Repo:      &templateRepositoryStub{},
		Generator: NewHTTPTemplateGenerator("", ""),
	}).CreateDesignDraft(response, request)
	if response.Code != http.StatusServiceUnavailable ||
		!strings.Contains(response.Body.String(), "template_generation_not_enabled") ||
		!strings.Contains(response.Body.String(), `"retryable":false`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestArchiveDesignDraftRequiresIdempotencyBeforeMutation(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/campaign-template-designs/design-1/archive",
		strings.NewReader(`{}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request = request.WithContext(middleware.WithTenant(
		request.Context(), &middleware.Tenant{ID: "tenant-1"},
	))
	request = request.WithContext(middleware.WithUser(
		request.Context(),
		&middleware.User{ID: "design-user", TenantID: "tenant-1"},
	))
	response := httptest.NewRecorder()
	(&Deps{Designs: &designDraftWorkerStoreStub{}}).
		ArchiveDesignDraft(response, request)
	if response.Code != http.StatusBadRequest ||
		!strings.Contains(response.Body.String(), "idempotency_key_required") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDesignDraftMigrationAndWorkerContainDurabilityGuards(t *testing.T) {
	migrationPath := filepath.Join("..", "..", "..", "..", "infra", "migrations",
		"1823_campaign_template_design_drafts.sql")
	migration, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatalf("read migration: %v", err)
	}
	sql := string(migration)
	for _, fragment := range []string{
		"campaign_template_design_drafts",
		"campaign_template_design_revisions",
		"output_hash ~ '^[0-9a-f]{64}$'",
		"campaign_template_design_revisions_immutable",
		"campaign_template_design_idempotency_idx",
		"campaign_templates_design_draft_once_idx",
		"campaigns_template_design_once_idx",
		"FORCE ROW LEVEL SECURITY",
		"app.outbox_worker",
	} {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration missing %q", fragment)
		}
	}
	repoSource, err := os.ReadFile("design_draft_repo.go")
	if err != nil {
		t.Fatalf("read repo: %v", err)
	}
	for _, fragment := range []string{
		"FOR UPDATE SKIP LOCKED", "lease_expires_at", "claim_token",
		"last_error_code = 'design_expired'", "expires_at > now()",
		"status IN ('ready', 'saved', 'campaign_created')",
	} {
		if !strings.Contains(string(repoSource), fragment) {
			t.Errorf("worker repo missing %q", fragment)
		}
	}
	mutationMigrationPath := filepath.Join(
		"..", "..", "..", "..", "infra", "migrations",
		"1826_campaign_template_design_mutation_idempotency.sql",
	)
	mutationMigration, err := os.ReadFile(mutationMigrationPath)
	if err != nil {
		t.Fatalf("read mutation migration: %v", err)
	}
	for _, fragment := range []string{
		"campaign_template_design_mutations",
		"UNIQUE (tenant_id, idempotency_key_hash)",
		"FORCE ROW LEVEL SECURITY",
		"prevent_campaign_template_design_mutation_change",
	} {
		if !strings.Contains(string(mutationMigration), fragment) {
			t.Errorf("mutation migration missing %q", fragment)
		}
	}
}
