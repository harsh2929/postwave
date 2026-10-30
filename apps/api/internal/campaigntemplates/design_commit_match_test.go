// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
)

func savedDesignCommitFixture() (
	CreateInput,
	*DesignDraft,
	*DesignRevision,
	*Template,
) {
	expected := CreateInput{
		Slug:        "weekly-product-digest",
		Name:        "Weekly Product Digest",
		Subject:     "What shipped this week",
		PreviewText: "A concise look at the latest improvements.",
		BodyHTML:    `<html><body><h1>Weekly digest</h1></body></html>`,
		BodyMJML:    `<mjml><mj-body><mj-text>Weekly digest</mj-text></mj-body></mjml>`,
		Variables: []map[string]interface{}{{
			"default": "friend",
			"name":    "first_name",
			"type":    "string",
		}},
		Category:             "newsletter",
		Goal:                 "newsletter",
		Industry:             "technology",
		Style:                "editorial",
		Layout:               "single-column",
		TemplateKind:         templateKindEditable,
		SourceProvider:       "postwave",
		SourceLicenseStatus:  licenseStatusOwned,
		ReviewStatus:         reviewStatusApproved,
		QualityScore:         0.75,
		ReferenceTemplateIDs: []string{"reference-a", "reference-b"},
	}
	draft := &DesignDraft{
		ID:              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		CurrentRevision: 7,
	}
	revision := &DesignRevision{
		DraftID:    draft.ID,
		Revision:   draft.CurrentRevision,
		OutputHash: strings.Repeat("a", 64),
	}
	existing := &Template{
		Slug:        expected.Slug,
		Name:        expected.Name,
		Subject:     expected.Subject,
		PreviewText: expected.PreviewText,
		BodyHTML:    expected.BodyHTML,
		BodyMJML:    expected.BodyMJML,
		Variables: []map[string]interface{}{{
			"type":    "string",
			"name":    "first_name",
			"default": "friend",
		}},
		Category:             expected.Category,
		Goal:                 expected.Goal,
		Industry:             expected.Industry,
		Style:                expected.Style,
		Layout:               expected.Layout,
		TemplateKind:         expected.TemplateKind,
		SourceProvider:       expected.SourceProvider,
		SourceLicenseStatus:  expected.SourceLicenseStatus,
		ReviewStatus:         expected.ReviewStatus,
		QualityScore:         expected.QualityScore,
		ReferenceTemplateIDs: []string{"reference-a", "reference-b"},
		GenerationMetadata: map[string]any{
			"operation":                "save_design_draft",
			"design_draft_id":          draft.ID,
			"design_draft_revision":    float64(revision.Revision),
			"design_draft_output_hash": revision.OutputHash,
		},
	}
	return expected, draft, revision, existing
}

func TestSavedTemplateMatchesExactDesignCommit(t *testing.T) {
	expected, draft, revision, existing := savedDesignCommitFixture()
	if !savedTemplateMatchesDesignCommit(existing, expected, draft, revision) {
		t.Fatal("an independently materialized exact saved-template outcome did not match")
	}
}

func TestSavedTemplateDesignCommitRejectsMaterializedMismatch(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Template)
	}{
		{
			name:   "slug",
			mutate: func(existing *Template) { existing.Slug = "different-slug" },
		},
		{
			name:   "name",
			mutate: func(existing *Template) { existing.Name = "Different name" },
		},
		{
			name:   "subject",
			mutate: func(existing *Template) { existing.Subject = "Different subject" },
		},
		{
			name: "preview text",
			mutate: func(existing *Template) {
				existing.PreviewText = "Different preview"
			},
		},
		{
			name:   "html body",
			mutate: func(existing *Template) { existing.BodyHTML = "<p>Different</p>" },
		},
		{
			name:   "mjml body",
			mutate: func(existing *Template) { existing.BodyMJML = "<mjml />" },
		},
		{
			name: "variables",
			mutate: func(existing *Template) {
				existing.Variables = []map[string]interface{}{{
					"default": "reader",
					"name":    "first_name",
					"type":    "string",
				}}
			},
		},
		{
			name: "reference templates",
			mutate: func(existing *Template) {
				existing.ReferenceTemplateIDs = []string{"reference-b", "reference-a"}
			},
		},
		{
			name:   "category",
			mutate: func(existing *Template) { existing.Category = "announcement" },
		},
		{
			name:   "goal",
			mutate: func(existing *Template) { existing.Goal = "promotional" },
		},
		{
			name:   "industry",
			mutate: func(existing *Template) { existing.Industry = "retail" },
		},
		{
			name:   "style",
			mutate: func(existing *Template) { existing.Style = "minimal" },
		},
		{
			name:   "layout",
			mutate: func(existing *Template) { existing.Layout = "two-column" },
		},
		{
			name: "template kind governance",
			mutate: func(existing *Template) {
				existing.TemplateKind = templateKindReference
			},
		},
		{
			name: "source provider governance",
			mutate: func(existing *Template) {
				existing.SourceProvider = "another-provider"
			},
		},
		{
			name: "license governance",
			mutate: func(existing *Template) {
				existing.SourceLicenseStatus = licenseStatusUnreviewed
			},
		},
		{
			name: "review governance",
			mutate: func(existing *Template) {
				existing.ReviewStatus = reviewStatusPending
			},
		},
		{
			name: "quality governance",
			mutate: func(existing *Template) {
				existing.QualityScore = 0.5
			},
		},
		{
			name: "draft lineage",
			mutate: func(existing *Template) {
				existing.GenerationMetadata["design_draft_id"] =
					"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
			},
		},
		{
			name: "revision lineage",
			mutate: func(existing *Template) {
				existing.GenerationMetadata["design_draft_revision"] = float64(8)
			},
		},
		{
			name: "output hash lineage",
			mutate: func(existing *Template) {
				existing.GenerationMetadata["design_draft_output_hash"] =
					strings.Repeat("b", 64)
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			expected, draft, revision, existing := savedDesignCommitFixture()
			testCase.mutate(existing)
			if savedTemplateMatchesDesignCommit(
				existing,
				expected,
				draft,
				revision,
			) {
				t.Fatalf("saved-template matcher accepted mismatched %s", testCase.name)
			}
		})
	}
}

func TestSavedTemplateDesignCommitRejectsIncompleteEvidence(t *testing.T) {
	expected, draft, revision, existing := savedDesignCommitFixture()
	for name, matches := range map[string]bool{
		"nil existing": savedTemplateMatchesDesignCommit(
			nil, expected, draft, revision,
		),
		"nil draft": savedTemplateMatchesDesignCommit(
			existing, expected, nil, revision,
		),
		"nil revision": savedTemplateMatchesDesignCommit(
			existing, expected, draft, nil,
		),
	} {
		if matches {
			t.Errorf("%s evidence unexpectedly matched", name)
		}
	}
	delete(existing.GenerationMetadata, "design_draft_output_hash")
	if savedTemplateMatchesDesignCommit(existing, expected, draft, revision) {
		t.Fatal("saved-template matcher accepted missing output-hash evidence")
	}
}

func createdCampaignDesignCommitFixture() (
	campaigns.CreateInput,
	*DesignDraft,
	*DesignRevision,
	*campaigns.Campaign,
) {
	expected := campaigns.CreateInput{
		Name:         "Weekly Product Digest",
		Subject:      "What shipped this week",
		PreviewText:  "A concise look at the latest improvements.",
		BodyHTML:     `<html><body><h1>Hello Ada</h1></body></html>`,
		BodyMJML:     `<mjml><mj-body><mj-text>Hello Ada</mj-text></mj-body></mjml>`,
		CampaignType: "regular",
		EditorMode:   "mjml",
		SegmentID:    "segment-engaged",
		ReferenceTemplateIDs: []string{
			"reference-a",
			"reference-b",
		},
		TemplateVariables: map[string]any{
			"brand":      map[string]any{"color": "#123456", "name": "Moosewave"},
			"first_name": "Ada",
		},
	}
	draft := &DesignDraft{
		ID:              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		CurrentRevision: 7,
	}
	revision := &DesignRevision{
		DraftID:    draft.ID,
		Revision:   draft.CurrentRevision,
		OutputHash: strings.Repeat("a", 64),
	}
	expected.SourceTemplateDesignDraftID = draft.ID
	expected.SourceTemplateDesignRevision = revision.Revision
	expected.SourceTemplateDesignOutputHash = revision.OutputHash
	existing := &campaigns.Campaign{
		Name:         expected.Name,
		Subject:      expected.Subject,
		PreviewText:  expected.PreviewText,
		BodyHTML:     expected.BodyHTML,
		BodyMJML:     expected.BodyMJML,
		CampaignType: expected.CampaignType,
		EditorMode:   expected.EditorMode,
		SegmentID:    expected.SegmentID,
		ListID:       expected.ListID,
		ReferenceTemplateIDs: []string{
			"reference-a",
			"reference-b",
		},
		TemplateVariables: map[string]any{
			"first_name": "Ada",
			"brand": map[string]any{
				"name":  "Moosewave",
				"color": "#123456",
			},
		},
		SourceTemplateDesignDraftID:    draft.ID,
		SourceTemplateDesignRevision:   revision.Revision,
		SourceTemplateDesignOutputHash: revision.OutputHash,
	}
	return expected, draft, revision, existing
}

func TestCreatedCampaignMatchesExactDesignCommit(t *testing.T) {
	expected, draft, revision, existing := createdCampaignDesignCommitFixture()
	if !createdCampaignMatchesDesignCommit(existing, expected, draft, revision) {
		t.Fatal("an independently materialized exact campaign outcome did not match")
	}
}

func TestCreatedCampaignDesignCommitRejectsMaterializedMismatch(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*campaigns.Campaign)
	}{
		{
			name:   "name",
			mutate: func(existing *campaigns.Campaign) { existing.Name = "Different name" },
		},
		{
			name: "subject",
			mutate: func(existing *campaigns.Campaign) {
				existing.Subject = "Different subject"
			},
		},
		{
			name: "preview text",
			mutate: func(existing *campaigns.Campaign) {
				existing.PreviewText = "Different preview"
			},
		},
		{
			name: "html body",
			mutate: func(existing *campaigns.Campaign) {
				existing.BodyHTML = "<p>Different</p>"
			},
		},
		{
			name: "mjml body",
			mutate: func(existing *campaigns.Campaign) {
				existing.BodyMJML = "<mjml />"
			},
		},
		{
			name: "campaign type",
			mutate: func(existing *campaigns.Campaign) {
				existing.CampaignType = "transactional"
			},
		},
		{
			name: "editor mode",
			mutate: func(existing *campaigns.Campaign) {
				existing.EditorMode = "html"
			},
		},
		{
			name: "segment audience",
			mutate: func(existing *campaigns.Campaign) {
				existing.SegmentID = "segment-all"
			},
		},
		{
			name: "list audience",
			mutate: func(existing *campaigns.Campaign) {
				existing.ListID = "42"
			},
		},
		{
			name: "variables",
			mutate: func(existing *campaigns.Campaign) {
				existing.TemplateVariables = map[string]any{
					"first_name": "Grace",
				}
			},
		},
		{
			name: "reference templates",
			mutate: func(existing *campaigns.Campaign) {
				existing.ReferenceTemplateIDs =
					[]string{"reference-b", "reference-a"}
			},
		},
		{
			name: "draft lineage",
			mutate: func(existing *campaigns.Campaign) {
				existing.SourceTemplateDesignDraftID =
					"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
			},
		},
		{
			name: "revision lineage",
			mutate: func(existing *campaigns.Campaign) {
				existing.SourceTemplateDesignRevision = 8
			},
		},
		{
			name: "output hash lineage",
			mutate: func(existing *campaigns.Campaign) {
				existing.SourceTemplateDesignOutputHash =
					strings.Repeat("b", 64)
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			expected, draft, revision, existing :=
				createdCampaignDesignCommitFixture()
			testCase.mutate(existing)
			if createdCampaignMatchesDesignCommit(
				existing,
				expected,
				draft,
				revision,
			) {
				t.Fatalf("campaign matcher accepted mismatched %s", testCase.name)
			}
		})
	}
}

func TestCreatedCampaignDesignCommitRejectsIncompleteEvidence(t *testing.T) {
	expected, draft, revision, existing := createdCampaignDesignCommitFixture()
	for name, matches := range map[string]bool{
		"nil existing": createdCampaignMatchesDesignCommit(
			nil, expected, draft, revision,
		),
		"nil draft": createdCampaignMatchesDesignCommit(
			existing, expected, nil, revision,
		),
		"nil revision": createdCampaignMatchesDesignCommit(
			existing, expected, draft, nil,
		),
	} {
		if matches {
			t.Errorf("%s evidence unexpectedly matched", name)
		}
	}
	existing.SourceTemplateDesignOutputHash = ""
	if createdCampaignMatchesDesignCommit(existing, expected, draft, revision) {
		t.Fatal("campaign matcher accepted missing output-hash evidence")
	}
}

func TestDesignCommitConflictsHaveStableHTTPContract(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
	}{
		{
			name: "different materialized outcome",
			err:  ErrDesignDraftOutcomeConflict,
			code: "design_commit_conflict",
		},
		{
			name: "unprovable legacy replay",
			err:  ErrDesignDraftReplayAmbiguous,
			code: "design_mutation_replay_ambiguous",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			request := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/campaign-template-designs/draft-1/action",
				nil,
			)
			writeDesignDraftError(
				response,
				request,
				nil,
				fmt.Errorf("service boundary: %w", testCase.err),
			)
			if response.Code != http.StatusConflict {
				t.Fatalf(
					"status = %d, want %d; body=%s",
					response.Code,
					http.StatusConflict,
					response.Body.String(),
				)
			}
			var body struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode error response: %v; body=%s", err, response.Body.String())
			}
			if body.Error.Code != testCase.code {
				t.Fatalf(
					"error code = %q, want %q; body=%s",
					body.Error.Code,
					testCase.code,
					response.Body.String(),
				)
			}
			if strings.TrimSpace(body.Error.Message) == "" {
				t.Fatalf("error message is empty; body=%s", response.Body.String())
			}
		})
	}
}
