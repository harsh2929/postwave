// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"encoding/json"
	"errors"
	"testing"
)

// A lossy import must produce an ERROR and no nodes.
//
// The importer's guarantee is that it never hands back a tree describing a
// message it cannot represent. That guarantee is only worth anything at the
// call site: a caller that took the unmapped report as advisory and persisted
// the nodes anyway would reintroduce the whole defect one layer up, and the
// downstream checks would report confidently about a document the customer
// never sent.
func TestImportLegacyRevisionRefusesALossyDocument(t *testing.T) {
	// A conditional comment: renders differently per client, so one tree cannot
	// describe both. This is the most common unrepresentable construct in real
	// campaign HTML.
	const lossy = `<p><!--[if mso]><table><![endif]--><img src="https://example.test/a.png" alt="Sale"></p>`

	nodes, unmapped, _, err := ImportLegacyRevisionV2(lossy, "en", "rev-1")
	if err == nil {
		t.Fatal("a lossy import returned no error; a partial tree must never be " +
			"persisted as source_mode='semantic'")
	}
	if nodes != nil {
		t.Fatalf("a lossy import returned %d bytes of nodes; it must return none", len(nodes))
	}
	if len(unmapped) == 0 {
		t.Fatal("a lossy import reported nothing unmapped, so an operator cannot " +
			"learn what could not be represented")
	}
	var validation *SemanticTreeValidationError
	if !errors.As(err, &validation) {
		t.Fatalf("err = %T, want *SemanticTreeValidationError so callers can branch on it", err)
	}

	// Guard the guard: the same shape WITHOUT the unrepresentable construct must
	// import cleanly, or this test would pass against a function that refused
	// everything.
	const clean = `<p><img src="https://example.test/a.png" alt="Sale"></p>`
	cleanNodes, cleanUnmapped, _, cleanErr := ImportLegacyRevisionV2(clean, "en", "rev-2")
	if cleanErr != nil {
		t.Fatalf("a representable document was refused: %v (unmapped=%+v)", cleanErr, cleanUnmapped)
	}
	if len(cleanNodes) == 0 {
		t.Fatal("a clean import produced no nodes")
	}
	var decoded []any
	if err := json.Unmarshal(cleanNodes, &decoded); err != nil {
		t.Fatalf("imported nodes are not a JSON array: %v", err)
	}
	if len(decoded) == 0 {
		t.Fatal("imported nodes decoded to an empty array")
	}
}
