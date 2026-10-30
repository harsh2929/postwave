// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
)

// A template body produced by the generator is machine-generated content.
//
// HTTPTemplateGenerator posts a brief and tone to the internal voice service
// and gets back HTML. That is the same kind of artifact aicompose marks under
// EU AI Act Article 50(2) — "so the marking travels with the content (survives
// editing/sending)" — and it flows onward into a template, and from a template
// into campaigns that get mailed to people.
//
// Marking happens where generated content ENTERS the system rather than at each
// place it is later written, because there are several of those (design
// revision, commit, template create, campaign-from-template) and only one
// boundary.

func TestGeneratedTemplateHTMLIsMarked(t *testing.T) {
	// Drives the real worker, NOT the helper. An earlier version of this test
	// called markGeneratedDesignHTML directly and stayed green when the call
	// site was reverted — it proved the helper worked and nothing about whether
	// the worker used it.
	referenceID := "11111111-1111-4111-8111-111111111111"
	store := &designDraftWorkerStoreStub{claim: &claimedDesignDraft{Draft: DesignDraft{
		ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tenantID: "tenant-1",
		Mode: designDraftModeGenerate, Status: designDraftStatusGenerating,
		ReferenceTemplateIDs: []string{referenceID},
		RequestPayload: CreateDesignDraftInput{
			Mode: designDraftModeGenerate, Brief: "Spring sale",
			PreviewText:          "The sale is on.",
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
		Name: "Spring sale", Subject: "The sale is on",
		BodyHTML: `<html><head><meta name="viewport" content="width=device-width"></head>` +
			`<body><a href="https://example.com">Shop</a>` +
			`<footer><a href="{{unsubscribe_url}}">Unsubscribe</a></footer>` +
			`</body></html>`,
	}}
	worker := &DesignDraftWorker{Store: store, Templates: repo, Generator: generator}
	if _, err := worker.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if !store.completed {
		t.Fatalf("worker did not complete: failed=%v", store.failed)
	}
	if !strings.Contains(store.output.BodyHTML, aidisclosure.Marker) {
		t.Fatalf("the committed design body is unmarked:\n%s", store.output.BodyHTML)
	}
}

func TestAnEmptyGeneratedBodyStaysEmpty(t *testing.T) {
	if got := markGeneratedDesignHTML(""); got != "" {
		t.Fatalf("empty body became %q", got)
	}
}

func TestReGeneratingDoesNotStackMarkers(t *testing.T) {
	// A refinement re-runs the generator over a body that may already carry the
	// marker. Stacking comments would change the output hash on every pass and
	// break the revision's immutability check.
	once := markGeneratedDesignHTML("<html><body>hi</body></html>")
	twice := markGeneratedDesignHTML(once)
	if once != twice {
		t.Fatalf("re-marking changed the body:\n once: %q\ntwice: %q", once, twice)
	}
	if n := strings.Count(twice, aidisclosure.Marker); n != 1 {
		t.Fatalf("marker appears %d times", n)
	}
}
