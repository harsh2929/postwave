package campaigns

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/factcontract"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

type campaignSemanticErrorEnvelope struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details struct {
			ValidationErrors []factcontract.ValidationError `json:"validation_errors"`
			MissingBlockIDs  []string                       `json:"missing_block_ids"`
			Diagnostics      []semanticemail.Diagnostic     `json:"diagnostics"`
		} `json:"details"`
	} `json:"error"`
}

func TestWriteCampaignSemanticErrorTypedASTDiagnostics(t *testing.T) {
	t.Parallel()

	want := semanticemail.Diagnostics{{
		Severity: semanticemail.SeverityError,
		Code:     semanticemail.CodeHTTPSRequired,
		Path:     "/nodes/1/content/action/canonical_url",
		NodeID:   "cta",
		Message:  "action URL must use HTTPS",
	}}
	rec := httptest.NewRecorder()
	handled := writeCampaignSemanticError(rec, fmt.Errorf("save campaign: %w",
		&campaignartifact.SemanticTreeValidationError{Diagnostics: want}))
	if !handled {
		t.Fatal("typed semantic-tree validation error was not handled")
	}
	body := decodeCampaignSemanticError(t, rec)
	if body.Error.Code != "semantic_content_invalid" {
		t.Fatalf("code = %q, want semantic_content_invalid", body.Error.Code)
	}
	if len(body.Error.Details.Diagnostics) != 1 || body.Error.Details.Diagnostics[0] != want[0] {
		t.Fatalf("diagnostics = %+v, want %+v", body.Error.Details.Diagnostics, want)
	}
}

func decodeCampaignSemanticError(t *testing.T, rec *httptest.ResponseRecorder) campaignSemanticErrorEnvelope {
	t.Helper()
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want JSON", got)
	}
	var body campaignSemanticErrorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

func TestWriteCampaignSemanticErrorFactContractValidation(t *testing.T) {
	t.Parallel()

	want := factcontract.ValidationErrors{
		{Path: "/primary_intent/statement", Code: factcontract.CodeRequired, Message: "statement is required"},
		{Path: "/primary_action/role", Code: factcontract.CodeInvalidEnum, Message: "role is not supported"},
	}
	rec := httptest.NewRecorder()
	handled := writeCampaignSemanticError(rec, fmt.Errorf("save campaign: %w",
		&campaignartifact.FactContractValidationError{Errors: want}))
	if !handled {
		t.Fatal("typed Fact Contract validation error was not handled")
	}
	body := decodeCampaignSemanticError(t, rec)
	if body.Error.Code != "fact_contract_invalid" {
		t.Fatalf("code = %q, want fact_contract_invalid", body.Error.Code)
	}
	if body.Error.Message != "Fact Contract validation failed" {
		t.Fatalf("message = %q", body.Error.Message)
	}
	if got := body.Error.Details.ValidationErrors; len(got) != len(want) {
		t.Fatalf("validation_errors = %+v, want %+v", got, want)
	} else {
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("validation_errors[%d] = %+v, want %+v", i, got[i], want[i])
			}
		}
	}
}

func TestWriteCampaignSemanticErrorMissingBlockReferences(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	handled := writeCampaignSemanticError(rec, fmt.Errorf("normalize: %w",
		&campaignartifact.FactContractReferenceError{
			MissingBlockIDs: []string{"cta-primary", "offer-deadline"},
		}))
	if !handled {
		t.Fatal("typed Fact Contract reference error was not handled")
	}
	body := decodeCampaignSemanticError(t, rec)
	if body.Error.Code != "fact_contract_references_invalid" {
		t.Fatalf("code = %q, want fact_contract_references_invalid", body.Error.Code)
	}
	want := []string{"cta-primary", "offer-deadline"}
	got := body.Error.Details.MissingBlockIDs
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("missing_block_ids = %#v, want %#v", got, want)
	}
}

func TestWriteCampaignSemanticErrorGenericInputIsSanitized(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	handled := writeCampaignSemanticError(rec, fmt.Errorf("persist secret implementation detail: %w",
		campaignartifact.ErrInvalidInput))
	if !handled {
		t.Fatal("campaign artifact invalid-input error was not handled")
	}
	body := decodeCampaignSemanticError(t, rec)
	if body.Error.Code != "campaign_semantics_invalid" {
		t.Fatalf("code = %q, want campaign_semantics_invalid", body.Error.Code)
	}
	if strings.Contains(rec.Body.String(), "secret implementation detail") {
		t.Fatalf("response leaked wrapped error: %s", rec.Body.String())
	}
}

func TestWriteCampaignSemanticErrorLeavesUnrelatedErrorsAlone(t *testing.T) {
	t.Parallel()

	rec := httptest.NewRecorder()
	if writeCampaignSemanticError(rec, fmt.Errorf("database unavailable")) {
		t.Fatal("unrelated error was handled")
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("unhandled error wrote a response: %s", rec.Body.String())
	}
}

func TestCreateMapsInvalidSourceSemantics(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name  string
		field string
	}{
		{name: "source mode", field: `"source_mode":"model_magic"`},
		{name: "schema version", field: `"content_schema_version":1001`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			rec := httptest.NewRecorder()
			(&Deps{Repo: &Repo{}}).Create(rec, campaignTenantRequest(
				http.MethodPost,
				"/api/v1/campaigns",
				`{"name":"Launch","subject":"Hello",`+tc.field+`}`,
			))
			body := decodeCampaignSemanticError(t, rec)
			if body.Error.Code != "campaign_semantics_invalid" {
				t.Fatalf("code = %q, want campaign_semantics_invalid", body.Error.Code)
			}
		})
	}
}
