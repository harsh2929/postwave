// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type hubspotMock struct {
	gotAuth      string
	patchEmail   string
	patchProps   map[string]string
	listAdded    []string
	contactFound bool
}

func (m *hubspotMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m.gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/crm/v3/objects/contacts/"):
			// idProperty=email; the {email} is the last path segment
			parts := strings.Split(strings.TrimRight(r.URL.Path, "/"), "/")
			m.patchEmail = parts[len(parts)-1]
			var in struct {
				Properties map[string]string `json:"properties"`
			}
			_ = json.Unmarshal(body, &in)
			m.patchProps = in.Properties
			if !m.contactFound {
				http.Error(w, `{"status":"error","message":"not found"}`, http.StatusNotFound)
				return
			}
			_, _ = w.Write([]byte(`{"id":"700123","properties":{}}`))
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/memberships/add"):
			var ids []string
			_ = json.Unmarshal(body, &ids)
			m.listAdded = append(m.listAdded, ids...)
			_, _ = w.Write([]byte(`{"recordIdsAdded":` + string(body) + `,"recordIdsMissing":[]}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}
}

func TestHubSpotWriteProfilePropertiesAndList(t *testing.T) {
	mock := &hubspotMock{contactFound: true}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := HubSpotWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "pat-na1-xxx"},
		map[string]any{"api_base_url": srv.URL, "list_id": "42"},
		ProfileWrite{Email: "Lead@Example.com", Fields: map[string]string{"lifecyclestage": "customer", "postwave_clv_tier": "gold"}},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 2 || res.TagsWritten != 1 {
		t.Fatalf("result=%+v", res)
	}
	if mock.gotAuth != "Bearer pat-na1-xxx" {
		t.Fatalf("bearer not sent: %q", mock.gotAuth)
	}
	if mock.patchEmail != "lead%40example.com" && mock.patchEmail != "lead@example.com" {
		t.Fatalf("PATCH not keyed by (escaped) email: %q", mock.patchEmail)
	}
	if mock.patchProps["lifecyclestage"] != "customer" || mock.patchProps["postwave_clv_tier"] != "gold" {
		t.Fatalf("properties not sent: %+v", mock.patchProps)
	}
	if len(mock.listAdded) != 1 || mock.listAdded[0] != "700123" {
		t.Fatalf("contact id not added to list: %+v", mock.listAdded)
	}
}

type hubspotBatchMock struct {
	existing     map[string]string // lowercased email -> contact id
	readCalls    int
	updateInputs []map[string]any
	listAdded    []string
}

func (m *hubspotBatchMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/batch/read"):
			m.readCalls++
			var in struct {
				Inputs []struct {
					ID string `json:"id"`
				} `json:"inputs"`
			}
			_ = json.Unmarshal(body, &in)
			results := []map[string]any{}
			for _, input := range in.Inputs {
				if id, ok := m.existing[strings.ToLower(input.ID)]; ok {
					results = append(results, map[string]any{
						"id":         id,
						"properties": map[string]string{"email": strings.ToLower(input.ID)},
					})
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"results": results})
		case strings.HasSuffix(r.URL.Path, "/batch/update"):
			var in struct {
				Inputs []map[string]any `json:"inputs"`
			}
			_ = json.Unmarshal(body, &in)
			m.updateInputs = append(m.updateInputs, in.Inputs...)
			_, _ = w.Write([]byte(`{"results":[]}`))
		case strings.HasSuffix(r.URL.Path, "/memberships/add"):
			var ids []string
			_ = json.Unmarshal(body, &ids)
			m.listAdded = append(m.listAdded, ids...)
			_, _ = w.Write([]byte(`{"recordIdsAdded":` + string(body) + `}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}
}

func TestHubSpotBatchWrite(t *testing.T) {
	mock := &hubspotBatchMock{existing: map[string]string{"a@example.com": "1", "b@x.com": "2"}}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := HubSpotWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.BatchWrite(context.Background(),
		map[string]string{"token": "pat"},
		map[string]any{"api_base_url": srv.URL, "list_id": "42"},
		[]ProfileWrite{
			{Email: "A@Example.com", Fields: map[string]string{"tier": "gold"}},
			{Email: "b@x.com", Fields: map[string]string{"tier": "silver"}},
			{Email: "ghost@x.com", Fields: map[string]string{"tier": "bronze"}}, // not in HubSpot
		},
	)
	if err != nil {
		t.Fatalf("BatchWrite: %v", err)
	}
	// Only the two existing contacts are matched/written — the ghost is never created.
	if res.Matched != 2 || res.FieldsWritten != 2 || res.TagsWritten != 2 || res.RowsFailed != 0 {
		t.Fatalf("result=%+v want {Matched:2 FieldsWritten:2 TagsWritten:2 RowsFailed:0}", res)
	}
	if mock.readCalls != 1 {
		t.Fatalf("expected a single batch read for the chunk, got %d", mock.readCalls)
	}
	if len(mock.updateInputs) != 2 {
		t.Fatalf("expected 2 batched property updates (matched only), got %d", len(mock.updateInputs))
	}
	if len(mock.listAdded) != 2 {
		t.Fatalf("expected both matched ids bulk-added to the list, got %+v", mock.listAdded)
	}
}

func TestHubSpotBatchWriteMergesDuplicateEmails(t *testing.T) {
	mock := &hubspotBatchMock{existing: map[string]string{"a@x.com": "1"}}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := HubSpotWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.BatchWrite(context.Background(),
		map[string]string{"token": "t"},
		map[string]any{"api_base_url": srv.URL},
		[]ProfileWrite{
			{Email: "a@x.com", Fields: map[string]string{"first": "1"}},
			{Email: "A@X.com", Fields: map[string]string{"second": "2"}}, // same email, different case
		},
	)
	if err != nil {
		t.Fatalf("BatchWrite: %v", err)
	}
	// Two profiles for one email collapse to a single contact — and NEITHER
	// profile's fields are dropped (the bug this guards against).
	if res.Matched != 1 {
		t.Fatalf("duplicate emails must collapse to one contact, got Matched=%d", res.Matched)
	}
	if mock.readCalls != 1 || len(mock.updateInputs) != 1 {
		t.Fatalf("expected one read + one merged update, got read=%d updates=%d", mock.readCalls, len(mock.updateInputs))
	}
	props, _ := mock.updateInputs[0]["properties"].(map[string]any)
	if props["first"] != "1" || props["second"] != "2" {
		t.Fatalf("merged update must carry both profiles' fields, got %+v", props)
	}
}

func TestHubSpotWriteProfileContactNotFound(t *testing.T) {
	mock := &hubspotMock{contactFound: false}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()
	adapter := HubSpotWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "t"},
		map[string]any{"api_base_url": srv.URL, "list_id": "42"},
		ProfileWrite{Email: "ghost@example.com", Fields: map[string]string{"x": "y"}},
	)
	if err != nil {
		t.Fatalf("missing contact is not an error: %v", err)
	}
	if res.Matched || res.TagsWritten != 0 {
		t.Fatalf("expected unmatched no-op: %+v", res)
	}
	if len(mock.listAdded) != 0 {
		t.Fatal("must not add to list when the contact was not found")
	}
}
