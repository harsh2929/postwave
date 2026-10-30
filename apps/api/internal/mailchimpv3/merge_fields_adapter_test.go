package mailchimpv3

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/merge_fields"
)

type fakeMergeFieldSchemaStore struct {
	mu sync.Mutex

	fields    []merge_fields.MergeFieldSchema
	listErr   error
	createErr error
	patchErr  error
	deleteErr error

	listCalls   int
	createCalls int
	patchCalls  int
	deleteCalls int
	tenantIDs   []string
}

func newFakeMergeFieldSchemaStore() *fakeMergeFieldSchemaStore {
	return &fakeMergeFieldSchemaStore{fields: []merge_fields.MergeFieldSchema{}}
}

func (f *fakeMergeFieldSchemaStore) ListSchema(_ context.Context, tenantID string) ([]merge_fields.MergeFieldSchema, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listCalls++
	f.tenantIDs = append(f.tenantIDs, tenantID)
	if f.listErr != nil {
		return nil, f.listErr
	}
	return append([]merge_fields.MergeFieldSchema(nil), f.fields...), nil
}

func (f *fakeMergeFieldSchemaStore) CreateSchema(_ context.Context, tenantID string, in merge_fields.SchemaInput) (*merge_fields.MergeFieldSchema, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.createCalls++
	f.tenantIDs = append(f.tenantIDs, tenantID)
	if f.createErr != nil {
		return nil, f.createErr
	}
	for _, field := range f.fields {
		if strings.EqualFold(field.Key, in.Key) {
			return nil, merge_fields.ErrKeyConflict
		}
	}
	field := merge_fields.MergeFieldSchema{
		TenantID:     tenantID,
		Key:          strings.ToUpper(in.Key),
		Label:        in.Label,
		Type:         merge_fields.FieldType(in.Type),
		DefaultValue: in.DefaultValue,
		Required:     in.Required,
		Position:     in.Position,
		CreatedAt:    "2026-07-18T00:00:00Z",
		UpdatedAt:    "2026-07-18T00:00:00Z",
	}
	f.fields = append(f.fields, field)
	return &field, nil
}

func (f *fakeMergeFieldSchemaStore) PatchSchema(_ context.Context, tenantID, key string, in merge_fields.SchemaPatch) (*merge_fields.MergeFieldSchema, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.patchCalls++
	f.tenantIDs = append(f.tenantIDs, tenantID)
	if f.patchErr != nil {
		return nil, f.patchErr
	}
	for i := range f.fields {
		if !strings.EqualFold(f.fields[i].Key, key) {
			continue
		}
		if in.Label != nil {
			f.fields[i].Label = strings.TrimSpace(*in.Label)
		}
		if in.Type != nil {
			f.fields[i].Type = merge_fields.FieldType(strings.ToLower(strings.TrimSpace(*in.Type)))
		}
		if in.DefaultValue != nil {
			f.fields[i].DefaultValue = strings.TrimSpace(*in.DefaultValue)
		}
		if in.Required != nil {
			f.fields[i].Required = *in.Required
		}
		if in.Position != nil {
			f.fields[i].Position = *in.Position
		}
		f.fields[i].UpdatedAt = "2026-07-18T01:00:00Z"
		field := f.fields[i]
		return &field, nil
	}
	return nil, merge_fields.ErrNotFound
}

func (f *fakeMergeFieldSchemaStore) DeleteSchema(_ context.Context, tenantID, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteCalls++
	f.tenantIDs = append(f.tenantIDs, tenantID)
	if f.deleteErr != nil {
		return f.deleteErr
	}
	for i := range f.fields {
		if strings.EqualFold(f.fields[i].Key, key) {
			f.fields = append(f.fields[:i], f.fields[i+1:]...)
			return nil
		}
	}
	return merge_fields.ErrNotFound
}

func TestMailchimpMergeFieldsCanonicalRoundTrip(t *testing.T) {
	mailchimpCompatLongTailState.Lock()
	mailchimpCompatLongTailState.items = map[string]compatStateRecord{}
	mailchimpCompatLongTailState.Unlock()

	fields := newFakeMergeFieldSchemaStore()
	router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)

	create := mergeFieldRequest(t, router, http.MethodPost, "/3.0/lists/demo/merge-fields",
		`{"tag":"is_vip","name":"VIP member","type":"radio","required":true,"public":true,"display_order":7,"default_value":true,"help_text":"","options":{"choices":["true","false"]}}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", create.Code, create.Body.String())
	}
	var created map[string]any
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	if created["tag"] != "IS_VIP" || created["type"] != "radio" || created["default_value"] != "true" {
		t.Fatalf("create response = %#v", created)
	}
	mergeID := int(created["merge_id"].(float64))
	if mergeID != stableMergeFieldNumber("demo:IS_VIP") || mergeID <= 0 {
		t.Fatalf("create merge_id=%d, want stable positive 31-bit id", mergeID)
	}

	list := mergeFieldRequest(t, router, http.MethodGet, "/3.0/lists/demo/merge-fields", "")
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"total_items":1`) || !strings.Contains(list.Body.String(), `"IS_VIP"`) {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	get := mergeFieldRequest(t, router, http.MethodGet, "/3.0/lists/demo/merge-fields/"+strconv.Itoa(mergeID), "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"name":"VIP member"`) {
		t.Fatalf("get status=%d body=%s", get.Code, get.Body.String())
	}
	legacyGet := mergeFieldRequest(t, router, http.MethodGet,
		"/3.0/lists/demo/merge-fields/"+strconv.Itoa(stableNumber("demo:IS_VIP")), "")
	if legacyGet.Code != http.StatusOK || !strings.Contains(legacyGet.Body.String(), `"tag":"IS_VIP"`) {
		t.Fatalf("legacy merge_id alias status=%d body=%s", legacyGet.Code, legacyGet.Body.String())
	}
	aliasGet := mergeFieldRequest(t, router, http.MethodGet,
		"/3.0/lists/00000000-0000-0000-0000-000000000001/merge-fields/"+strconv.Itoa(mergeID), "")
	if aliasGet.Code != http.StatusOK || !strings.Contains(aliasGet.Body.String(), `"list_id":"demo"`) {
		t.Fatalf("tenant-id alias changed canonical list identity: status=%d body=%s", aliasGet.Code, aliasGet.Body.String())
	}

	update := mergeFieldRequest(t, router, http.MethodPatch, "/3.0/lists/demo/merge-fields/IS_VIP",
		`{"tag":"IS_VIP","name":"VIP status","required":false,"display_order":9,"default_value":false}`)
	if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"name":"VIP status"`) || !strings.Contains(update.Body.String(), `"default_value":"false"`) {
		t.Fatalf("update status=%d body=%s", update.Code, update.Body.String())
	}
	if fields.fields[0].Label != "VIP status" || fields.fields[0].DefaultValue != "false" || fields.fields[0].Required || fields.fields[0].Position != 9 {
		t.Fatalf("canonical field after update = %+v", fields.fields[0])
	}

	deleted := mergeFieldRequest(t, router, http.MethodDelete, "/3.0/lists/demo/merge-fields/IS_VIP", "")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	missing := mergeFieldRequest(t, router, http.MethodDelete, "/3.0/lists/demo/merge-fields/IS_VIP", "")
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "could not be found") {
		t.Fatalf("missing delete status=%d body=%s", missing.Code, missing.Body.String())
	}

	for _, tenantID := range fields.tenantIDs {
		if tenantID != "00000000-0000-0000-0000-000000000001" {
			t.Fatalf("canonical adapter received tenant %q", tenantID)
		}
	}
	mailchimpCompatLongTailState.Lock()
	defer mailchimpCompatLongTailState.Unlock()
	for _, item := range mailchimpCompatLongTailState.items {
		if item.Kind == "merge_field" {
			t.Fatalf("merge field leaked into compatibility state: %#v", item)
		}
	}
}

func TestMailchimpMergeFieldsFailClosedAndStableProblems(t *testing.T) {
	t.Run("no synthetic defaults", func(t *testing.T) {
		fields := newFakeMergeFieldSchemaStore()
		router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)
		response := mergeFieldRequest(t, router, http.MethodGet, "/3.0/lists/demo/merge-fields", "")
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"merge_fields":[]`) || !strings.Contains(response.Body.String(), `"total_items":0`) {
			t.Fatalf("empty list status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("native long tags remain addressable without synthetic id collisions", func(t *testing.T) {
		fields := newFakeMergeFieldSchemaStore()
		fields.fields = append(fields.fields, merge_fields.MergeFieldSchema{
			TenantID: "00000000-0000-0000-0000-000000000001",
			Key:      "CUSTOMER_LIFETIME_VALUE",
			Label:    "Lifetime value",
			Type:     merge_fields.TypeNumber,
		})
		router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)
		get := mergeFieldRequest(t, router, http.MethodGet,
			"/3.0/lists/demo/merge-fields/demo:customer_lifetime_value", "")
		if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"tag":"CUSTOMER_LIFETIME_VALUE"`) {
			t.Fatalf("long-tag get status=%d body=%s", get.Code, get.Body.String())
		}
		update := mergeFieldRequest(t, router, http.MethodPatch,
			"/3.0/lists/demo/merge-fields/CUSTOMER_LIFETIME_VALUE",
			`{"tag":"CUSTOMER_LIFETIME_VALUE","name":"Customer lifetime value"}`)
		if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"name":"Customer lifetime value"`) {
			t.Fatalf("long-tag update status=%d body=%s", update.Code, update.Body.String())
		}
	})

	t.Run("invalid unsupported metadata is not silently dropped", func(t *testing.T) {
		fields := newFakeMergeFieldSchemaStore()
		router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)
		response := mergeFieldRequest(t, router, http.MethodPost, "/3.0/lists/demo/merge-fields",
			`{"tag":"CITY","name":"City","type":"text","help_text":"This would be lost"}`)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "Merge field input is invalid") {
			t.Fatalf("invalid status=%d body=%s", response.Code, response.Body.String())
		}
		if fields.createCalls != 0 {
			t.Fatalf("invalid request reached persistence: %d calls", fields.createCalls)
		}
	})

	t.Run("persistence errors never become success or leak details", func(t *testing.T) {
		fields := newFakeMergeFieldSchemaStore()
		fields.createErr = errors.New("database password and internal table leaked")
		router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)
		response := mergeFieldRequest(t, router, http.MethodPost, "/3.0/lists/demo/merge-fields",
			`{"tag":"CITY","name":"City","type":"text"}`)
		if response.Code != http.StatusInternalServerError || strings.Contains(response.Body.String(), "password") || !strings.Contains(response.Body.String(), "internal error") {
			t.Fatalf("internal status=%d body=%s", response.Code, response.Body.String())
		}
	})

	t.Run("domain errors are stable", func(t *testing.T) {
		cases := []struct {
			name   string
			err    error
			method string
			want   int
			detail string
		}{
			{name: "conflict", err: merge_fields.ErrKeyConflict, method: http.MethodPost, want: http.StatusConflict, detail: "already exists"},
			{name: "schema limit", err: merge_fields.ErrSchemaLimit, method: http.MethodPost, want: http.StatusBadRequest, detail: "50 merge-field limit"},
			{name: "field in use", err: merge_fields.ErrFieldInUse, method: http.MethodDelete, want: http.StatusConflict, detail: "stored subscriber values"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				fields := newFakeMergeFieldSchemaStore()
				path := "/3.0/lists/demo/merge-fields"
				body := `{"tag":"CITY","name":"City"}`
				if tc.method == http.MethodPost {
					fields.createErr = tc.err
				} else {
					fields.fields = append(fields.fields, merge_fields.MergeFieldSchema{Key: "CITY", Label: "City", Type: merge_fields.TypeText})
					fields.deleteErr = tc.err
					path += "/CITY"
					body = ""
				}
				router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)
				response := mergeFieldRequest(t, router, tc.method, path, body)
				if response.Code != tc.want || !strings.Contains(response.Body.String(), tc.detail) {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
			})
		}
	})

	t.Run("wrong list never reaches canonical store", func(t *testing.T) {
		fields := newFakeMergeFieldSchemaStore()
		router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, fields)
		response := mergeFieldRequest(t, router, http.MethodGet, "/3.0/lists/another-tenant/merge-fields", "")
		if response.Code != http.StatusNotFound || fields.listCalls != 0 {
			t.Fatalf("wrong-list status=%d list_calls=%d body=%s", response.Code, fields.listCalls, response.Body.String())
		}
	})

	t.Run("missing production dependency fails closed", func(t *testing.T) {
		router := testV3RouterWithMergeFields(&fakeV3Store{member: &Member{}}, nil)
		response := mergeFieldRequest(t, router, http.MethodGet, "/3.0/lists/demo/merge-fields", "")
		if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), "internal error") {
			t.Fatalf("missing dependency status=%d body=%s", response.Code, response.Body.String())
		}
	})
}

func TestMailchimpMergeFieldTypeAndDefaultMapping(t *testing.T) {
	types := []struct {
		canonical merge_fields.FieldType
		mailchimp string
	}{
		{canonical: merge_fields.TypeText, mailchimp: "text"},
		{canonical: merge_fields.TypeNumber, mailchimp: "number"},
		{canonical: merge_fields.TypeBoolean, mailchimp: "radio"},
		{canonical: merge_fields.TypeDate, mailchimp: "date"},
		{canonical: merge_fields.TypeAddress, mailchimp: "address"},
		{canonical: merge_fields.TypePhone, mailchimp: "phone"},
	}
	for _, tc := range types {
		t.Run(tc.mailchimp, func(t *testing.T) {
			mapped, err := mailchimpMergeFieldType(tc.canonical)
			if err != nil || mapped != tc.mailchimp {
				t.Fatalf("canonical %q maps to %q, %v", tc.canonical, mapped, err)
			}
			canonical, err := canonicalMergeFieldType(tc.mailchimp, map[string]any{})
			if err != nil || canonical != tc.canonical {
				t.Fatalf("Mailchimp %q maps to %q, %v", tc.mailchimp, canonical, err)
			}
		})
	}
	if _, err := canonicalMergeFieldType("dropdown", map[string]any{"choices": []any{"a", "b"}}); !errors.Is(err, merge_fields.ErrInvalidInput) {
		t.Fatalf("unsupported dropdown error = %v", err)
	}
	if _, err := canonicalMergeFieldType("radio", map[string]any{"choices": []any{"yes", "no"}}); !errors.Is(err, merge_fields.ErrInvalidInput) {
		t.Fatalf("lossy radio error = %v", err)
	}

	defaults := []struct {
		raw  string
		want string
	}{
		{raw: `"hello"`, want: "hello"},
		{raw: `1.25`, want: "1.25"},
		{raw: `true`, want: "true"},
		{raw: `null`, want: ""},
	}
	for _, tc := range defaults {
		got, provided, err := canonicalDefaultValue(json.RawMessage(tc.raw))
		if err != nil || !provided || got != tc.want {
			t.Errorf("default %s = %q, provided=%v, err=%v", tc.raw, got, provided, err)
		}
	}
	if _, _, err := canonicalDefaultValue(json.RawMessage(`{"nested":true}`)); !errors.Is(err, merge_fields.ErrInvalidInput) {
		t.Fatalf("object default error = %v", err)
	}
}

func mergeFieldRequest(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
