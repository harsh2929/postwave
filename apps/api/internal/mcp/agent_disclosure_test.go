// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Agent-authored campaign HTML must carry the same disclosure marker as
// compose-authored HTML.
//
// `aicompose/handlers.go` marks its output: "mark the machine-generated email
// body so the marking travels with the content (survives editing/sending)".
// The agent surface produces the same kind of artifact — an email body written
// by a model and mailed to people — through `create_campaign`, and passed
// `in.BodyHTML` into `campaigns.CreateInput` untouched.
//
// One product, two rules. The EU AI Act obligations are also distinct and it is
// worth being precise about which one this is: Article 50(1) is the "you are
// talking to an AI" notice, which the agent already emits as an SSE frame.
// This is Article 50(2) — machine-readable marking of generated CONTENT — and
// a metadata frame on a chat stream does not discharge it, because the frame
// does not travel with the email.

// recordingCreator captures what the tool actually hands the campaigns service.
type recordingCreator struct{ got campaigns.CreateInput }

func (r *recordingCreator) Create(_ context.Context, _ string, in campaigns.CreateInput) (*campaigns.Campaign, error) {
	r.got = in
	return &campaigns.Campaign{ID: "c1", Name: in.Name, Subject: in.Subject}, nil
}

func TestAgentAuthoredCampaignHTMLIsMarked(t *testing.T) {
	// Drives handleCreateCampaign, NOT the helper. An earlier version of this
	// test called markAgentGeneratedHTML directly and stayed green when the call
	// site was reverted to pass in.BodyHTML through untouched — it proved the
	// helper worked and nothing about whether anyone used it.
	creator := &recordingCreator{}
	d := &Deps{CampaignCreate: creator}
	args := json.RawMessage(`{"name":"Spring","subject":"Sale",` +
		`"body_html":"<html><body><h1>Spring sale</h1></body></html>"}`)

	if _, err := handleCreateCampaign(middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}), d, args); err != nil {
		t.Fatalf("handleCreateCampaign: %v", err)
	}
	if !strings.Contains(creator.got.BodyHTML, aidisclosure.Marker) {
		t.Fatalf("the campaigns service received unmarked agent HTML: %q", creator.got.BodyHTML)
	}
	// Same marker aicompose uses, so the two surfaces cannot drift.
	if creator.got.BodyHTML != aidisclosure.MarkHTML("<html><body><h1>Spring sale</h1></body></html>") {
		t.Fatalf("agent marking diverged from aicompose's: %q", creator.got.BodyHTML)
	}
}

func TestASubjectOnlyDraftIsNotGivenABody(t *testing.T) {
	creator := &recordingCreator{}
	d := &Deps{CampaignCreate: creator}
	if _, err := handleCreateCampaign(middleware.WithTenant(context.Background(), &middleware.Tenant{ID: "11111111-1111-1111-1111-111111111111"}), d,
		json.RawMessage(`{"name":"Draft","subject":"Later"}`)); err != nil {
		t.Fatalf("handleCreateCampaign: %v", err)
	}
	if creator.got.BodyHTML != "" {
		t.Fatalf("an empty body became %q — the editor would treat this draft as "+
			"having content", creator.got.BodyHTML)
	}
}

func TestMarkingAnEmptyBodyStaysEmpty(t *testing.T) {
	// A campaign created without HTML (subject-only draft, or an MJML/plain
	// path) must not gain a body consisting of nothing but a comment — that
	// would turn an empty draft into one the editor thinks has content.
	if got := markAgentGeneratedHTML(""); got != "" {
		t.Fatalf("empty body became %q", got)
	}
	if got := markAgentGeneratedHTML("   "); strings.Contains(got, aidisclosure.Marker) {
		t.Fatalf("whitespace-only body was marked: %q", got)
	}
}

func TestMarkingIsIdempotent(t *testing.T) {
	// The agent can revise a draft it already created. Marking twice must not
	// stack comments.
	once := markAgentGeneratedHTML("<html><body>hi</body></html>")
	twice := markAgentGeneratedHTML(once)
	if once != twice {
		t.Fatalf("re-marking changed the body:\n once: %q\ntwice: %q", once, twice)
	}
	if strings.Count(twice, aidisclosure.Marker) != 1 {
		t.Fatalf("marker appears %d times", strings.Count(twice, aidisclosure.Marker))
	}
}
