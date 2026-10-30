// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/customfields"
)

// A CSV with any column the detector cannot name ("plan") maps it to a custom
// field. Every row of such a file used to fail Review with "Custom field
// schema validation failed", even in a workspace whose Settings said new
// fields are registered automatically, because the import never read the mode.

func planCSV(suffix string) (string, string, string) {
	pro := "pro-" + suffix + "@example.com"
	free := "free-" + suffix + "@example.com"
	return "email,plan\n" + pro + ",pro\n" + free + ",free\n", pro, free
}

// mapAsWizard saves the Map step the way the web wizard does: the detected
// mapping, the collision strategy and the "create new custom fields" choice in
// one PATCH under the preview's revision.
func (f *importFlow) mapAsWizard(preview previewResponse, createCustomFields bool) int64 {
	f.t.Helper()
	mapping, err := json.Marshal(preview.Mapping)
	if err != nil {
		f.t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"configuration_revision": preview.ConfigurationRevision,
		"mapping":                json.RawMessage(mapping),
		"on_existing":            "skip",
		"auto_create_properties": createCustomFields,
	})
	rec := f.patch(preview.ID, string(body))
	if rec.Code != http.StatusOK {
		f.t.Fatalf("map PATCH status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Revision int64 `json:"configuration_revision"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out.Revision
}

func (f *importFlow) declaredCustomField(key string) (customfields.CustomField, bool) {
	f.t.Helper()
	fields, err := (&customfields.Repo{Pool: f.app}).List(context.Background(), f.tenantID)
	if err != nil {
		f.t.Fatalf("list custom fields: %v", err)
	}
	for _, field := range fields {
		if field.Key == key {
			return field, true
		}
	}
	return customfields.CustomField{}, false
}

func (f *importFlow) customFieldValue(email, key string) any {
	f.t.Helper()
	var raw []byte
	if err := f.admin.QueryRow(context.Background(), `
SELECT custom_fields FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`,
		f.tenantID, email).Scan(&raw); err != nil {
		f.t.Fatalf("read custom fields of %s: %v", email, err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		f.t.Fatal(err)
	}
	return fields[key]
}

func TestPreviewDefaultsCustomFieldCreationToTheWorkspaceModeDB(t *testing.T) {
	for _, test := range []struct {
		stored     string
		wantCreate bool
	}{
		{stored: "", wantCreate: true},
		{stored: "auto", wantCreate: true},
		{stored: "strict", wantCreate: false},
		{stored: "off", wantCreate: false},
	} {
		t.Run("mode="+test.stored, func(t *testing.T) {
			flow := newImportFlow(t)
			if test.stored != "" {
				flow.setCustomFieldsMode(test.stored)
			}
			csvBody, _, _ := planCSV(uuid.NewString()[:8])
			preview := flow.upload("plans.csv", csvBody)
			// Read back through GET, the import resource every client reads.
			rec := flow.serve(http.MethodGet, "/api/v1/subscriber-imports/"+preview.ID, "", nil)
			if rec.Code != http.StatusOK {
				t.Fatalf("get status=%d body=%s", rec.Code, rec.Body.String())
			}
			var resource struct {
				AutoCreateProperties bool `json:"auto_create_properties"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &resource); err != nil {
				t.Fatal(err)
			}
			if resource.AutoCreateProperties != test.wantCreate {
				t.Fatalf("mode %q: auto_create_properties=%v, want %v", test.stored, resource.AutoCreateProperties, test.wantCreate)
			}
		})
	}
}

// The wizard saves the detected mapping as-is; a detected key the PATCH would
// reject ("plan-type") used to stop the operator at Map with a 400.
func TestPreviewMappingIsConfirmableAsDetectedDB(t *testing.T) {
	flow := newImportFlow(t)
	suffix := uuid.NewString()[:8]
	preview := flow.upload("plans.csv", "email,Plan-Type\nhyphen-"+suffix+"@example.com,pro\n")
	var planColumn string
	for _, column := range preview.Mapping.Columns {
		if column.Name == "Plan-Type" {
			planColumn = column.CustomKey
		}
	}
	if planColumn != "plan_type" {
		t.Fatalf("detected key for Plan-Type=%q, want plan_type (mapping=%+v)", planColumn, preview.Mapping.Columns)
	}
	flow.mapAsWizard(preview, true)
	if results := flow.preflight(preview.ID); results.WouldCreate != 1 {
		t.Fatalf("preflight create=%d rows=%+v, want 1", results.WouldCreate, results.Rows)
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)
	if _, declared := flow.declaredCustomField("plan_type"); !declared {
		t.Fatal("the detected key plan_type was not created by the import")
	}
}

func TestAutoModeCreatesMappedCustomFieldsAndImportsTheirValuesDB(t *testing.T) {
	flow := newImportFlow(t)
	flow.setCustomFieldsMode("auto")
	csvBody, pro, free := planCSV(uuid.NewString()[:8])
	preview := flow.upload("plans.csv", csvBody)
	flow.mapAsWizard(preview, true)

	results := flow.preflight(preview.ID)
	if results.WouldCreate != 2 || results.WouldFail != 0 {
		t.Fatalf("preflight create=%d fail=%d rows=%+v, want 2/0", results.WouldCreate, results.WouldFail, results.Rows)
	}
	if _, declared := flow.declaredCustomField("plan"); declared {
		t.Fatal("the preflight registered a custom field; it must never change the schema")
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)

	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsImported != 2 || outcome.RowsFailed != 0 {
		t.Fatalf("import outcome=%+v, want 2 imported", outcome)
	}
	field, declared := flow.declaredCustomField("plan")
	if !declared || field.Type != customfields.TypeString {
		t.Fatalf("plan field declared=%v type=%q, want a text field", declared, field.Type)
	}
	if got := flow.customFieldValue(pro, "plan"); got != "pro" {
		t.Fatalf("pro plan=%v", got)
	}
	if got := flow.customFieldValue(free, "plan"); got != "free" {
		t.Fatalf("free plan=%v", got)
	}
}

func TestAutoModeImportThatOptsOutFailsUndeclaredKeysDB(t *testing.T) {
	flow := newImportFlow(t)
	flow.setCustomFieldsMode("auto")
	csvBody, _, _ := planCSV(uuid.NewString()[:8])
	preview := flow.upload("plans.csv", csvBody)
	flow.mapAsWizard(preview, false)

	results := flow.preflight(preview.ID)
	if results.WouldCreate != 0 || results.WouldFail != 2 {
		t.Fatalf("opted-out preflight create=%d fail=%d", results.WouldCreate, results.WouldFail)
	}
	row := dryRunRowByNumber(t, results, 1)
	if row.ErrorCode != rowCodeUnknownCustomField || !strings.Contains(row.Error, `"plan"`) ||
		!strings.Contains(row.Error, "Let the import create it") {
		t.Fatalf("opted-out row=%+v", row)
	}
}

func TestStrictModeNeverCreatesCustomFieldsDB(t *testing.T) {
	flow := newImportFlow(t)
	flow.setCustomFieldsMode("strict")
	csvBody, pro, free := planCSV(uuid.NewString()[:8])
	preview := flow.upload("plans.csv", csvBody)

	optIn, _ := json.Marshal(map[string]any{
		"configuration_revision": preview.ConfigurationRevision,
		"auto_create_properties": true,
	})
	rec := flow.patch(preview.ID, string(optIn))
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"custom_fields_mode_strict"`) {
		t.Fatalf("strict opt-in status=%d body=%s, want 409 custom_fields_mode_strict", rec.Code, rec.Body.String())
	}

	results := flow.preflight(preview.ID)
	if results.WouldCreate != 0 || results.WouldFail != 2 {
		t.Fatalf("strict preflight create=%d fail=%d", results.WouldCreate, results.WouldFail)
	}
	for _, rowNumber := range []int64{1, 2} {
		row := dryRunRowByNumber(t, results, rowNumber)
		if row.ErrorCode != rowCodeUnknownCustomField || !strings.Contains(row.Error, `"plan"`) ||
			!strings.Contains(row.Error, "only accepts defined custom fields") ||
			strings.Contains(row.Error, "pro") || strings.Contains(row.Error, "free") {
			t.Fatalf("strict row %d=%+v", rowNumber, row)
		}
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)

	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsImported != 0 || outcome.RowsFailed != 2 {
		t.Fatalf("strict import outcome=%+v, want 2 failed", outcome)
	}
	if _, declared := flow.declaredCustomField("plan"); declared {
		t.Fatal("a strict workspace had a custom field created by an import")
	}
	if flow.subscriberCount(pro) != 0 || flow.subscriberCount(free) != 0 {
		t.Fatal("a row with an undeclared custom field was written in a strict workspace")
	}
	for _, item := range flow.rowErrors(preview.ID) {
		if item.ErrorCode != rowCodeUnknownCustomField {
			t.Fatalf("strict row error=%+v", item)
		}
	}
}

func TestOffModePassesCustomFieldValuesThroughUntouchedDB(t *testing.T) {
	flow := newImportFlow(t)
	flow.setCustomFieldsMode("off")
	csvBody, pro, _ := planCSV(uuid.NewString()[:8])
	preview := flow.upload("plans.csv", csvBody)

	results := flow.preflight(preview.ID)
	if results.WouldCreate != 2 || results.WouldFail != 0 {
		t.Fatalf("off preflight create=%d fail=%d", results.WouldCreate, results.WouldFail)
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)

	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsImported != 2 {
		t.Fatalf("off import outcome=%+v", outcome)
	}
	if _, declared := flow.declaredCustomField("plan"); declared {
		t.Fatal("off mode registered a custom field")
	}
	if got := flow.customFieldValue(pro, "plan"); got != "pro" {
		t.Fatalf("off-mode plan=%v, want the raw string", got)
	}
}

func TestChangingTheModeAfterPreflightRequiresANewOneDB(t *testing.T) {
	flow := newImportFlow(t)
	flow.setCustomFieldsMode("auto")
	csvBody, _, _ := planCSV(uuid.NewString()[:8])
	preview := flow.upload("plans.csv", csvBody)
	if results := flow.preflight(preview.ID); results.WouldCreate != 2 {
		t.Fatalf("auto preflight create=%d", results.WouldCreate)
	}
	flow.setCustomFieldsMode("strict")
	rec := flow.confirm(preview.ID)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"preflight_required"`) {
		t.Fatalf("confirm after mode change status=%d body=%s, want 409 preflight_required", rec.Code, rec.Body.String())
	}

	// The upload still carries the auto-mode opt-in, but the workspace is now
	// strict: the fresh preflight and the run must both refuse to create.
	if results := flow.preflight(preview.ID); results.WouldFail != 2 {
		t.Fatalf("strict re-preflight fail=%d, want 2", results.WouldFail)
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm after fresh preflight status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)
	if outcome := flow.outcome(preview.ID); outcome.Status != "ready" || outcome.RowsFailed != 2 {
		t.Fatalf("strict run outcome=%+v, want 2 failed", outcome)
	}
	if _, declared := flow.declaredCustomField("plan"); declared {
		t.Fatal("the worker created a custom field in a strict workspace because the upload had opted in")
	}
}

func TestCustomFieldRowFailuresNameTheFieldNeverTheValueDB(t *testing.T) {
	flow := newImportFlow(t)
	ctx := context.Background()
	if _, err := (&customfields.Repo{Pool: flow.app}).Create(ctx, flow.tenantID, "age", "Age", customfields.TypeNumber); err != nil {
		t.Fatalf("declare age: %v", err)
	}
	suffix := uuid.NewString()[:8]
	bad := "bad-" + suffix + "@example.com"
	good := "good-" + suffix + "@example.com"
	preview := flow.upload("ages.csv", "email,age\n"+bad+",abc\n"+good+",42\n")

	results := flow.preflight(preview.ID)
	row := dryRunRowByNumber(t, results, 1)
	wantMessage := `The value for custom field "age" must be a number.`
	if row.ErrorCode != rowCodeCustomFieldType || row.Error != wantMessage {
		t.Fatalf("mismatch row=%+v, want %s %q", row, rowCodeCustomFieldType, wantMessage)
	}
	if rec := flow.confirm(preview.ID); rec.Code != http.StatusAccepted {
		t.Fatalf("confirm status=%d body=%s", rec.Code, rec.Body.String())
	}
	flow.execute(preview.ID)
	items := flow.rowErrors(preview.ID)
	if len(items) != 1 || items[0].RowNumber != 1 || items[0].ErrorCode != rowCodeCustomFieldType || items[0].Error != wantMessage {
		t.Fatalf("row errors=%+v", items)
	}
	if got := flow.customFieldValue(good, "age"); got != float64(42) {
		t.Fatalf("good age=%#v, want the coerced number 42", got)
	}
}

// The validator's enum and format errors quote the rejected value in their
// Reason text; the row message must describe the field's rule instead.
func TestConstraintViolationsDescribeTheRuleNotTheValueDB(t *testing.T) {
	flow := newImportFlow(t)
	ctx := context.Background()
	repo := &customfields.Repo{Pool: flow.app}
	if _, err := repo.Create(ctx, flow.tenantID, "tier", "Tier", customfields.TypeEnum,
		customfields.CreateMeta{Config: &customfields.FieldConfig{Options: []string{"gold", "silver"}}}); err != nil {
		t.Fatalf("declare tier: %v", err)
	}
	if _, err := repo.Create(ctx, flow.tenantID, "website", "Website", customfields.TypeURL); err != nil {
		t.Fatalf("declare website: %v", err)
	}
	suffix := uuid.NewString()[:8]
	preview := flow.upload("tiers.csv", "email,tier,website\n"+
		"enum-"+suffix+"@example.com,platinum-secret,https://example.com\n"+
		"url-"+suffix+"@example.com,gold,not a web address secret\n")

	results := flow.preflight(preview.ID)
	for rowNumber, want := range map[int64]string{
		1: `The value for custom field "tier" isn't one of the options set for it under Settings › Custom fields.`,
		2: `The value for custom field "website" must be a valid web address.`,
	} {
		row := dryRunRowByNumber(t, results, rowNumber)
		if row.ErrorCode != rowCodeCustomFieldValidation || row.Error != want {
			t.Fatalf("row %d=%+v, want %q", rowNumber, row, want)
		}
		if strings.Contains(row.Error, "secret") {
			t.Fatalf("row %d message repeats the cell value: %q", rowNumber, row.Error)
		}
	}
}
