package subscribers

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildCreateInput_DefaultsCSVImportToUnconfirmedWithoutConsent(t *testing.T) {
	header := indexHeader([]string{"email", "status", "tags", "plan"})
	got, err := buildCreateInput([]string{
		"reader@example.com",
		"",
		"founder, import",
		"pro",
	}, header)
	if err != nil {
		t.Fatalf("buildCreateInput: %v", err)
	}
	if got.ConsentSource != ConsentUnknown {
		t.Fatalf("ConsentSource = %q, want %q", got.ConsentSource, ConsentUnknown)
	}
	if err := normalizeCreate(&got); err != nil {
		t.Fatalf("normalizeCreate: %v", err)
	}
	if got.MailchimpStatus != "non_subscribed" {
		t.Fatalf("MailchimpStatus = %q, want non_subscribed", got.MailchimpStatus)
	}
	if got.Status != StatusUnconfirmed {
		t.Fatalf("Status = %q, want %q", got.Status, StatusUnconfirmed)
	}
	if got.CustomFields["plan"] != "pro" {
		t.Fatalf("custom plan = %v, want pro", got.CustomFields["plan"])
	}
}

func TestReadImportBodyRejectsOversizedRawCSV(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers/import", strings.NewReader("email\nreader@example.com\n"))
	req.Header.Set("Content-Type", "text/csv")
	req.ContentLength = bulkImportMaxBodyBytes + 1
	rec := httptest.NewRecorder()
	body, _, err := readImportBody(rec, req)
	if body != nil {
		_ = body.Close()
	}
	if !errors.Is(err, errBulkImportBodyTooLarge) {
		t.Fatalf("err = %v, want errBulkImportBodyTooLarge", err)
	}
}
