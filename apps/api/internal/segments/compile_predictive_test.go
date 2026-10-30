package segments

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestCompileASTPredictiveCLVPredicate(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"predictive.total_clv_cents","comparator":"gte","value":50000}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "profile_predictions") || !strings.Contains(frag, "total_clv_cents") {
		t.Fatalf("fragment did not target profile_predictions total CLV: %s", frag)
	}
	if len(args) != 1 || args[0] != float64(50000) {
		t.Fatalf("args = %#v", args)
	}
}

func TestCompileASTRFMSegmentPredicate(t *testing.T) {
	raw := json.RawMessage(`{"op":"condition","field":"rfm.segment_key","comparator":"in","value":["champions","loyal_customers"]}`)
	frag, args, err := CompileAST(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(frag, "profile_rfm_scores") || !strings.Contains(frag, "segment_key") {
		t.Fatalf("fragment did not target profile_rfm_scores segment: %s", frag)
	}
	if len(args) != 2 || args[0] != "champions" || args[1] != "loyal_customers" {
		t.Fatalf("args = %#v", args)
	}
}
