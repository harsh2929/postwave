// SPDX-License-Identifier: AGPL-3.0-only

package campaigntemplates

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type designRefinementReplayStore struct {
	DesignDraftStore
	draft        *DesignDraft
	revisions    []DesignRevision
	getErr       error
	revisionsErr error
}

func (store *designRefinementReplayStore) Get(
	context.Context,
	string,
	ReferenceReviewActor,
	string,
) (*DesignDraft, error) {
	return store.draft, store.getErr
}

func (store *designRefinementReplayStore) ListRevisions(
	context.Context,
	string,
	ReferenceReviewActor,
	string,
) ([]DesignRevision, error) {
	return store.revisions, store.revisionsErr
}

func TestRefinementReplayAcceptsOnlyExactMaterializedReceipt(t *testing.T) {
	input := RefineDesignDraftInput{
		Instructions: "Improve the visual rhythm",
		BaseRevision: 1,
	}
	requestHash := normalizedRefinementRequestHash(input)
	baseRevision := input.BaseRevision
	draft := &DesignDraft{
		ID:              "draft-1",
		Status:          designDraftStatusReady,
		CurrentRevision: 2,
	}
	store := &designRefinementReplayStore{
		draft: draft,
		revisions: []DesignRevision{{
			DraftID:               draft.ID,
			Revision:              2,
			Operation:             "refine",
			BaseRevision:          &baseRevision,
			refinementRequestHash: requestHash[:],
		}},
	}

	got, satisfied := (&Deps{Designs: store}).replayedDesignMutationDraft(
		context.Background(),
		"tenant-1",
		designUnitTestActor,
		draft.ID,
		"refine",
		input,
	)
	if !satisfied || got != draft {
		t.Fatalf("replay = (%#v, %v), want exact draft and satisfied", got, satisfied)
	}
}

func TestRefinementReplayRejectsAmbiguousMaterializedRevisions(t *testing.T) {
	input := RefineDesignDraftInput{
		Instructions: "Improve the visual rhythm",
		BaseRevision: 1,
	}
	requestHash := normalizedRefinementRequestHash(input)
	differentHash := normalizedRefinementRequestHash(RefineDesignDraftInput{
		Instructions: "Use a completely different visual direction",
		BaseRevision: input.BaseRevision,
	})
	wrongBase := input.BaseRevision + 1
	cases := []struct {
		name     string
		revision DesignRevision
	}{
		{
			name: "different request hash",
			revision: DesignRevision{
				Operation:             "refine",
				BaseRevision:          &input.BaseRevision,
				refinementRequestHash: differentHash[:],
			},
		},
		{
			name: "different operation",
			revision: DesignRevision{
				Operation:             "repair",
				BaseRevision:          &input.BaseRevision,
				refinementRequestHash: requestHash[:],
			},
		},
		{
			name: "different base revision",
			revision: DesignRevision{
				Operation:             "refine",
				BaseRevision:          &wrongBase,
				refinementRequestHash: requestHash[:],
			},
		},
		{
			name: "missing base revision",
			revision: DesignRevision{
				Operation:             "refine",
				refinementRequestHash: requestHash[:],
			},
		},
		{
			name: "pre-1831 null receipt",
			revision: DesignRevision{
				Operation:    "refine",
				BaseRevision: &input.BaseRevision,
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			draft := &DesignDraft{
				ID:              "draft-1",
				Status:          designDraftStatusReady,
				CurrentRevision: 2,
			}
			testCase.revision.DraftID = draft.ID
			testCase.revision.Revision = 2
			store := &designRefinementReplayStore{
				draft:     draft,
				revisions: []DesignRevision{testCase.revision},
			}

			got, satisfied := (&Deps{Designs: store}).replayedDesignMutationDraft(
				context.Background(),
				"tenant-1",
				designUnitTestActor,
				draft.ID,
				"refine",
				input,
			)
			if satisfied || got != nil {
				t.Fatalf(
					"replay = (%#v, %v), want fail-closed ambiguity",
					got,
					satisfied,
				)
			}
		})
	}
}

func TestRefinementReplayMatchesOnlyExactPendingRequest(t *testing.T) {
	baseRevision := 3
	draft := &DesignDraft{
		ID:                  "draft-1",
		Status:              designDraftStatusQueued,
		CurrentRevision:     baseRevision,
		pendingOperation:    "refine",
		pendingBaseRevision: &baseRevision,
		pendingPayload: RefineDesignDraftInput{
			Instructions: "  Strengthen the hierarchy  ",
			BaseRevision: baseRevision,
		},
	}
	deps := &Deps{Designs: &designRefinementReplayStore{draft: draft}}

	got, satisfied := deps.replayedDesignMutationDraft(
		context.Background(),
		"tenant-1",
		designUnitTestActor,
		draft.ID,
		"refine",
		RefineDesignDraftInput{
			Instructions: "Strengthen the hierarchy",
			BaseRevision: baseRevision,
		},
	)
	if !satisfied || got != draft {
		t.Fatalf("exact pending replay = (%#v, %v), want satisfied", got, satisfied)
	}

	for _, different := range []RefineDesignDraftInput{
		{
			Instructions: "Use a denser layout",
			BaseRevision: baseRevision,
		},
		{
			Instructions: "Strengthen the hierarchy",
			BaseRevision: baseRevision - 1,
		},
	} {
		got, satisfied = deps.replayedDesignMutationDraft(
			context.Background(),
			"tenant-1",
			designUnitTestActor,
			draft.ID,
			"refine",
			different,
		)
		if satisfied || got != nil {
			t.Fatalf(
				"different pending replay %#v = (%#v, %v), want fail closed",
				different,
				got,
				satisfied,
			)
		}
	}
}

func TestNormalizedRefinementRequestHashTrimsOuterWhitespace(t *testing.T) {
	withWhitespace := normalizedRefinementRequestHash(RefineDesignDraftInput{
		Instructions: " \n  Improve the visual rhythm\t ",
		BaseRevision: 4,
	})
	canonical := normalizedRefinementRequestHash(RefineDesignDraftInput{
		Instructions: "Improve the visual rhythm",
		BaseRevision: 4,
	})
	if !bytes.Equal(withWhitespace[:], canonical[:]) {
		t.Fatalf("normalized request hashes differ: %x != %x", withWhitespace, canonical)
	}

	differentBase := normalizedRefinementRequestHash(RefineDesignDraftInput{
		Instructions: "Improve the visual rhythm",
		BaseRevision: 5,
	})
	if bytes.Equal(canonical[:], differentBase[:]) {
		t.Fatal("base revision is missing from the normalized request identity")
	}
}

func TestRefinementReceiptIsNeverSerialized(t *testing.T) {
	baseRevision := 1
	revision := DesignRevision{
		ID:                    "revision-2",
		DraftID:               "draft-1",
		Revision:              2,
		Operation:             "refine",
		BaseRevision:          &baseRevision,
		refinementRequestHash: []byte{1, 2, 3, 4},
	}
	draft := DesignDraft{
		ID:              revision.DraftID,
		CurrentRevision: revision.Revision,
		Revision:        &revision,
	}

	for name, value := range map[string]any{
		"revision": revision,
		"draft":    draft,
	} {
		t.Run(name, func(t *testing.T) {
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatalf("marshal %s: %v", name, err)
			}
			if bytes.Contains(raw, []byte("refinement_request_hash")) ||
				bytes.Contains(raw, []byte("AQIDBA==")) {
				t.Fatalf("server-only receipt leaked in %s JSON: %s", name, raw)
			}
		})
	}
}

func TestDesignMutationReceiptMigrationsFailClosedAndBoundEvidence(t *testing.T) {
	migrationsDir := filepath.Join(
		"..", "..", "..", "..", "infra", "migrations",
	)
	assertMigrationFragments := func(
		t *testing.T,
		filename string,
		fragments ...string,
	) {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join(migrationsDir, filename))
		if err != nil {
			t.Fatalf("read %s: %v", filename, err)
		}
		sql := string(raw)
		for _, fragment := range fragments {
			if !strings.Contains(sql, fragment) {
				t.Errorf("%s missing %q", filename, fragment)
			}
		}
	}

	assertMigrationFragments(
		t,
		"1831_campaign_template_design_refinement_receipts.sql",
		"ADD COLUMN refinement_request_hash bytea",
		"octet_length(refinement_request_hash) = 32",
		"campaign_template_design_refinement_receipt_idx",
		"WHERE operation = 'refine'",
		"refinement_request_hash IS NOT NULL",
		"Existing revisions remain NULL",
	)
	assertMigrationFragments(
		t,
		"1832_campaign_template_design_retry_receipts.sql",
		"ADD COLUMN registered_attempt_count integer",
		"registered_attempt_count IS NULL",
		"registered_attempt_count >= 0",
		"Existing mutation rows remain NULL",
		"NULL for non-retry and pre-1832 identities",
		"enforce_campaign_template_design_retry_receipt",
		"app.campaign_template_design_retry_key_hash",
		"mutation.registered_attempt_count =",
		"OLD.attempt_count",
		"campaign_template_design_retry_receipt_guard",
	)
}
