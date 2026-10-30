package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/generation"
	"github.com/postwave/postwave/services/voice/internal/ingest"
	"github.com/postwave/postwave/services/voice/internal/templates"
)

// This file pins ONE property of the op-delta surface, because a client can
// only choose correctly between `steps` and `ops` if it knows it:
//
//	an op list is bound to the exact revision it was computed against.
//
// `applySequenceOps` addresses steps by POSITION (indexByPosition) and
// renumbers the list 1..N after every op, so the same op list applied to two
// different bases yields two different trees. That is fine for a client that
// re-derives its delta from a freshly fetched row on every write. It is NOT
// fine for a client that queues writes offline and replays them later against
// whatever revision it has since confirmed.
//
// The mobile app is the second kind: its offline queue deliberately re-points
// a queued sequence write at a newer revision
// (apps/mobile/src/lib/offlineMutations.ts — `expectedVersion =
// Math.max(vars.baseVersion, cachedVersion)`), which is sound only because the
// payload is a whole snapshot. The tests below are the reason mobile keeps
// sending `steps` and does not adopt `ops`; see
// apps/mobile/src/lib/sequenceWireDiff.ts for the client-side note that points
// back here.

func emailStep(position int, subject string) generation.Step {
	return generation.Step{
		Type:     generation.StepTypeEmail,
		Position: position,
		Email:    &generation.EmailConfig{Subject: subject, Body: "body"},
	}
}

func subjects(steps []generation.Step) []string {
	out := make([]string, 0, len(steps))
	for _, s := range steps {
		if s.Email != nil {
			out = append(out, s.Email.Subject)
			continue
		}
		out = append(out, string(s.Type))
	}
	return out
}

// A delta computed against revision N, admitted at revision N+1, is accepted
// and silently produces a tree the author never asked for. Nothing 412s: the
// If-Match precondition guards the ROW VERSION, not the base the ops assumed.
func TestSequenceOpsAreBoundToTheRevisionTheyWereComputedAgainst(t *testing.T) {
	baseAtV1 := []generation.Step{
		emailStep(1, "A"),
		emailStep(2, "B"),
		emailStep(3, "C"),
	}

	// Author, against v1: "delete the middle step".
	delta := []sequenceOp{{Op: "delete", StepID: 2}}

	intended, err := applySequenceOps(baseAtV1, delta)
	if err != nil {
		t.Fatalf("apply against the authored base: %v", err)
	}
	if got, want := subjects(intended), []string{"A", "C"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("authored intent = %v, want %v", got, want)
	}

	// Meanwhile another write lands, so the row is now v2 with a prepended
	// step — exactly what an earlier queued save of this same client does.
	baseAtV2 := []generation.Step{
		emailStep(1, "Z"),
		emailStep(2, "A"),
		emailStep(3, "B"),
		emailStep(4, "C"),
	}

	replayed, err := applySequenceOps(baseAtV2, delta)
	if err != nil {
		t.Fatalf("replay against the newer base must not error — that is the "+
			"whole problem: %v", err)
	}

	// The op was accepted and deleted a DIFFERENT step. No error, no 412, no
	// signal of any kind that the user's intent was not carried out.
	if got, want := subjects(replayed), []string{"Z", "B", "C"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("replayed result = %v, want %v", got, want)
	}
	if reflect.DeepEqual(subjects(replayed), subjects(intended)) {
		t.Fatal("expected the replayed delta to diverge from the authored intent")
	}
}

// The counterpart property, driven through the real handler: the SAME full
// `steps` snapshot converges on the same tree no matter which revision it
// lands on. This is what makes the mobile client's replay chaining safe, and
// it is the thing that would be lost by switching that client to `ops`.
func TestFullStepArrayReplayConvergesFromAnyBase(t *testing.T) {
	snapshot := `{"steps":[
		{"type":"email","position":1,"email":{"subject":"A","body":"body"}},
		{"type":"email","position":2,"email":{"subject":"C","body":"body"}}
	]}`

	bases := map[string][]generation.Step{
		"authored base": {emailStep(1, "A"), emailStep(2, "B"), emailStep(3, "C")},
		"newer base":    {emailStep(1, "Z"), emailStep(2, "A"), emailStep(3, "B")},
		"single step":   {emailStep(1, "Q")},
	}

	for name, base := range bases {
		store := NewMemorySequenceStore()
		h := New(ingest.NewRegistry(), NewMemoryStore(), nil).WithGeneration(GenerationDeps{
			Engine:    &generation.Engine{},
			Templates: templates.NewMemoryStore(),
			Sequences: store,
		})
		if err := store.Save(context.Background(), generation.Sequence{
			ID: "seq-replay", TenantID: "tenant-1", Name: "Replay",
			Status: "draft", Steps: base,
		}); err != nil {
			t.Fatalf("%s: seed: %v", name, err)
		}

		read := httptest.NewRequest(http.MethodGet, "/sequences/seq-replay", nil)
		read.Header.Set("X-Tenant-ID", "tenant-1")
		recRead := httptest.NewRecorder()
		h.Routes().ServeHTTP(recRead, read)
		etag := strings.TrimSpace(recRead.Header().Get("ETag"))

		req := httptest.NewRequest(http.MethodPatch, "/sequences/seq-replay", strings.NewReader(snapshot))
		req.Header.Set("X-Tenant-ID", "tenant-1")
		req.Header.Set("If-Match", etag)
		rec := httptest.NewRecorder()
		h.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200: %s", name, rec.Code, rec.Body.String())
		}
		var got generation.Sequence
		if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
			t.Fatalf("%s: decode: %v", name, err)
		}
		if want := []string{"A", "C"}; !reflect.DeepEqual(subjects(got.Steps), want) {
			t.Fatalf("%s: snapshot replay = %v, want %v", name, subjects(got.Steps), want)
		}
	}
}

// Renumbering after every op is what makes positions unstable mid-request, so
// a delta is not even self-consistent unless its author simulated the server.
// Pinned because a client-side encoder would have to reproduce it exactly.
func TestSequenceOpsRenumberAfterEveryOperation(t *testing.T) {
	base := []generation.Step{emailStep(1, "A"), emailStep(2, "B"), emailStep(3, "C")}

	// Delete position 1, then delete position 1 again: after the first op the
	// list is renumbered, so the second op removes what was originally "B".
	out, err := applySequenceOps(base, []sequenceOp{
		{Op: "delete", StepID: 1},
		{Op: "delete", StepID: 1},
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got, want := subjects(out), []string{"C"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("result = %v, want %v", got, want)
	}
	for i, s := range out {
		if s.Position != i+1 {
			t.Fatalf("step %d has position %d, want dense 1..N", i, s.Position)
		}
	}
}
