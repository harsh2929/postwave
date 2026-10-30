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

type klaviyoWritebackMock struct {
	auth          string
	revision      string
	filter        string
	patchID       string
	patchProps    map[string]any
	listIDs       []string
	eventProfile  string
	eventMetric   string
	eventProps    map[string]any
	lookups       int
	patches       int
	listAdds      int
	eventCreates  int
	existingEmail map[string]string
}

func (m *klaviyoWritebackMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m.auth = r.Header.Get("Authorization")
		m.revision = r.Header.Get("revision")
		w.Header().Set("Content-Type", "application/vnd.api+json")
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/profiles":
			m.lookups++
			m.filter = r.URL.Query().Get("filter")
			data := []map[string]any{}
			for email, id := range m.existingEmail {
				if strings.Contains(m.filter, email) {
					data = append(data, map[string]any{
						"type":       "profile",
						"id":         id,
						"attributes": map[string]any{"email": email},
					})
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
		case r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/profiles/"):
			m.patches++
			m.patchID = strings.TrimPrefix(r.URL.Path, "/profiles/")
			var in struct {
				Data struct {
					Type       string `json:"type"`
					ID         string `json:"id"`
					Attributes struct {
						Properties map[string]any `json:"properties"`
					} `json:"attributes"`
				} `json:"data"`
			}
			_ = json.Unmarshal(body, &in)
			m.patchProps = in.Data.Attributes.Properties
			_, _ = w.Write([]byte(`{"data":{"type":"profile","id":"` + in.Data.ID + `"}}`))
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/relationships/profiles"):
			m.listAdds++
			var in struct {
				Data []struct {
					Type string `json:"type"`
					ID   string `json:"id"`
				} `json:"data"`
			}
			_ = json.Unmarshal(body, &in)
			for _, item := range in.Data {
				m.listIDs = append(m.listIDs, item.ID)
			}
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/events":
			m.eventCreates++
			var in struct {
				Data struct {
					Attributes struct {
						Properties map[string]any `json:"properties"`
						Metric     struct {
							Data struct {
								Attributes struct {
									Name string `json:"name"`
								} `json:"attributes"`
							} `json:"data"`
						} `json:"metric"`
						Profile struct {
							Data struct {
								ID string `json:"id"`
							} `json:"data"`
						} `json:"profile"`
					} `json:"attributes"`
				} `json:"data"`
			}
			_ = json.Unmarshal(body, &in)
			m.eventProfile = in.Data.Attributes.Profile.Data.ID
			m.eventMetric = in.Data.Attributes.Metric.Data.Attributes.Name
			m.eventProps = in.Data.Attributes.Properties
			w.WriteHeader(http.StatusAccepted)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}
}

func TestKlaviyoWriteProfileUpdatesExistingProfileListAndEvent(t *testing.T) {
	mock := &klaviyoWritebackMock{existingEmail: map[string]string{"lead@example.com": "01HPROFILE"}}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := KlaviyoWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"api_key": "pk_test"},
		map[string]any{
			"api_base_url":             srv.URL,
			"list_id":                  "LIST123",
			"event_name":               "Moosewave Audience Synced",
			"tags_property":            "postwave_tags",
			"event_properties":         map[string]any{"source_list": "vip"},
			"klaviyo_event_properties": map[string]any{"operator": "native"},
			"klaviyo_revision":         "2026-04-15",
		},
		ProfileWrite{
			Email:  "Lead@Example.com",
			Tags:   []string{"vip", "newsletter"},
			Fields: map[string]string{"postwave_clv_tier": "gold", "lifetime_value": "42"},
		},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 2 || res.TagsWritten != 3 {
		t.Fatalf("result=%+v", res)
	}
	if mock.auth != "Klaviyo-API-Key pk_test" || mock.revision != "2026-04-15" {
		t.Fatalf("headers auth=%q revision=%q", mock.auth, mock.revision)
	}
	if mock.patchID != "01HPROFILE" || mock.patchProps["postwave_clv_tier"] != "gold" || mock.patchProps["lifetime_value"] != "42" {
		t.Fatalf("profile patch wrong: id=%q props=%+v", mock.patchID, mock.patchProps)
	}
	tags, ok := mock.patchProps["postwave_tags"].([]any)
	if !ok || len(tags) != 2 || tags[0] != "vip" {
		t.Fatalf("tags property not written: %+v", mock.patchProps["postwave_tags"])
	}
	if len(mock.listIDs) != 1 || mock.listIDs[0] != "01HPROFILE" {
		t.Fatalf("list add wrong: %+v", mock.listIDs)
	}
	if mock.eventProfile != "01HPROFILE" || mock.eventMetric != "Moosewave Audience Synced" {
		t.Fatalf("event profile/metric wrong: profile=%q metric=%q", mock.eventProfile, mock.eventMetric)
	}
	if mock.eventProps["postwave_source"] != "integration_writeback" || mock.eventProps["source_list"] != "vip" || mock.eventProps["operator"] != "native" {
		t.Fatalf("event properties wrong: %+v", mock.eventProps)
	}
}

func TestKlaviyoWriteProfileMissingProfileDoesNotCreate(t *testing.T) {
	mock := &klaviyoWritebackMock{existingEmail: map[string]string{}}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := KlaviyoWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "pk_test"},
		map[string]any{"api_base_url": srv.URL, "list_id": "LIST123", "event_name": "Moosewave Audience Synced"},
		ProfileWrite{Email: "ghost@example.com", Fields: map[string]string{"tier": "gold"}},
	)
	if err != nil {
		t.Fatalf("missing profile should not error: %v", err)
	}
	if res.Matched || res.FieldsWritten != 0 || res.TagsWritten != 0 {
		t.Fatalf("expected unmatched no-op: %+v", res)
	}
	if mock.patches != 0 || mock.listAdds != 0 || mock.eventCreates != 0 {
		t.Fatalf("missing profile must not be created or written: patches=%d list=%d events=%d", mock.patches, mock.listAdds, mock.eventCreates)
	}
}

func TestKlaviyoBatchWriteMergesDuplicateEmails(t *testing.T) {
	mock := &klaviyoWritebackMock{existingEmail: map[string]string{"a@example.com": "01HA"}}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := KlaviyoWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.BatchWrite(context.Background(),
		map[string]string{"private_api_key": "pk"},
		map[string]any{"api_base_url": srv.URL, "klaviyo_list_id": "LIST"},
		[]ProfileWrite{
			{Email: "a@example.com", Fields: map[string]string{"first": "1"}},
			{Email: "A@Example.com", Fields: map[string]string{"second": "2"}},
			{Email: "ghost@example.com", Fields: map[string]string{"ignored": "true"}},
		},
	)
	if err != nil {
		t.Fatalf("BatchWrite: %v", err)
	}
	if res.Matched != 1 || res.FieldsWritten != 2 || res.TagsWritten != 1 || res.RowsFailed != 0 {
		t.Fatalf("result=%+v", res)
	}
	if mock.lookups != 1 || mock.patches != 1 || mock.listAdds != 1 {
		t.Fatalf("unexpected call counts lookups=%d patches=%d list=%d", mock.lookups, mock.patches, mock.listAdds)
	}
	if mock.patchProps["first"] != "1" || mock.patchProps["second"] != "2" {
		t.Fatalf("duplicate fields were not merged: %+v", mock.patchProps)
	}
	if len(mock.listIDs) != 1 || mock.listIDs[0] != "01HA" {
		t.Fatalf("list add should include only matched profile id: %+v", mock.listIDs)
	}
}

func TestKlaviyoWriteProfileRateLimitIsRetryableMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "17")
		http.Error(w, "slow down", http.StatusTooManyRequests)
	}))
	defer srv.Close()

	adapter := KlaviyoWritebackAdapter{HTTPClient: srv.Client()}
	_, err := adapter.WriteProfile(context.Background(),
		map[string]string{"api_key": "pk"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "lead@example.com"},
	)
	if err == nil || !strings.Contains(err.Error(), "retry after 17") {
		t.Fatalf("expected Retry-After rate limit error, got %v", err)
	}
}
