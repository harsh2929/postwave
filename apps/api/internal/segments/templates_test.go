// templates_test.go — SUB-034: predictive segment templates.
package segments

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSegmentTemplateCatalogShape(t *testing.T) {
	cat := SegmentTemplateCatalog()
	if len(cat) != 3 {
		t.Fatalf("expected 3 templates (High-CLV, At-Risk, Likely-to-Churn), got %d", len(cat))
	}
	wantKeys := map[string]bool{"high_clv": false, "at_risk": false, "likely_to_churn": false}
	for _, tpl := range cat {
		if tpl.Key == "" || tpl.Label == "" || tpl.Description == "" {
			t.Fatalf("template missing required metadata: %#v", tpl)
		}
		if tpl.SuggestedName == "" {
			t.Fatalf("template %q missing suggested_name", tpl.Key)
		}
		if len(tpl.PredicateJSON) == 0 {
			t.Fatalf("template %q missing predicate_json", tpl.Key)
		}
		if _, ok := wantKeys[tpl.Key]; ok {
			wantKeys[tpl.Key] = true
		}
	}
	for k, seen := range wantKeys {
		if !seen {
			t.Errorf("expected template key %q in catalog", k)
		}
	}
}

// TestSegmentTemplateASTsCompile is the SUB-034 regression guard: every
// template AST MUST compile against the live segment compiler so a
// one-click "apply" can never materialize a segment that fails to
// preview. It also pins that the predictive/RFM predicates route to the
// expected backing tables.
func TestSegmentTemplateASTsCompile(t *testing.T) {
	for _, tpl := range SegmentTemplateCatalog() {
		frag, args, err := CompileAST(tpl.PredicateJSON)
		if err != nil {
			t.Fatalf("template %q AST did not compile: %v", tpl.Key, err)
		}
		if frag == "" {
			t.Fatalf("template %q produced empty fragment", tpl.Key)
		}
		switch tpl.Key {
		case "high_clv":
			if !strings.Contains(frag, "profile_predictions") || !strings.Contains(frag, "predicted_clv_cents") {
				t.Fatalf("high_clv must target predicted CLV: %s", frag)
			}
		case "at_risk":
			if !strings.Contains(frag, "profile_rfm_scores") || !strings.Contains(frag, "segment_key") {
				t.Fatalf("at_risk must target RFM segment: %s", frag)
			}
			if len(args) != 2 {
				t.Fatalf("at_risk should bind both RFM buckets, args=%#v", args)
			}
		case "likely_to_churn":
			if !strings.Contains(frag, "profile_predictions") || !strings.Contains(frag, "churn_risk") {
				t.Fatalf("likely_to_churn must target churn_risk: %s", frag)
			}
		}
	}
}

func TestSegmentTemplatesHandler(t *testing.T) {
	deps := &Deps{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/segments/templates", nil)
	rec := httptest.NewRecorder()

	deps.SegmentTemplates(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var resp SegmentTemplatesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}
	if len(resp.Items) != 3 {
		t.Fatalf("expected 3 template items, got %d", len(resp.Items))
	}
	if resp.Items[0].IconHint == "" {
		t.Fatalf("expected icon_hint on template card: %#v", resp.Items[0])
	}
}
