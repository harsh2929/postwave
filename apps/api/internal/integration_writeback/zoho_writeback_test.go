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

type zohoMock struct {
	gotAuth   string
	contactID string // returned by search; "" => 204 no match
	sawUpdate bool
	updateRec map[string]any
	tagNames  string
	tagStatus int // 0 => 200 OK; otherwise the status add_tags returns
}

func (m *zohoMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		m.gotAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "/Contacts/search"):
			if m.contactID == "" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"` + m.contactID + `"}]}`))
		case strings.Contains(r.URL.Path, "/actions/add_tags"):
			m.tagNames = r.URL.Query().Get("tag_names")
			if m.tagStatus != 0 {
				http.Error(w, `{"code":"INVALID_DATA","message":"invalid tag name"}`, m.tagStatus)
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"code":"SUCCESS"}]}`))
		case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/Contacts"):
			m.sawUpdate = true
			var in struct {
				Data []map[string]any `json:"data"`
			}
			_ = json.Unmarshal(body, &in)
			if len(in.Data) > 0 {
				m.updateRec = in.Data[0]
			}
			_, _ = w.Write([]byte(`{"data":[{"code":"SUCCESS"}]}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}
}

func TestZohoWriteProfile(t *testing.T) {
	mock := &zohoMock{contactID: "zc_900"}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := ZohoWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "ztok"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "Lead@Example.com", Tags: []string{"VIP", "Newsletter"}, Fields: map[string]string{"Lead_Source": "Moosewave"}},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 1 || res.TagsWritten != 2 {
		t.Fatalf("result=%+v", res)
	}
	if mock.gotAuth != "Zoho-oauthtoken ztok" {
		t.Fatalf("oauth header not sent: %q", mock.gotAuth)
	}
	if !mock.sawUpdate || mock.updateRec["id"] != "zc_900" || mock.updateRec["Lead_Source"] != "Moosewave" {
		t.Fatalf("update record wrong: %+v", mock.updateRec)
	}
	if mock.tagNames != "VIP,Newsletter" {
		t.Fatalf("tags not added via add_tags: %q", mock.tagNames)
	}
}

func TestZohoWriteProfileTagFailureIsBestEffort(t *testing.T) {
	mock := &zohoMock{contactID: "zc_900", tagStatus: http.StatusBadRequest} // add_tags rejects
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := ZohoWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "z"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "lead@example.com", Tags: []string{"Unknown-Tag"}, Fields: map[string]string{"Lead_Source": "Moosewave"}},
	)
	// A rejected tag must NOT discard the successful field write (Zoho add_tags can
	// reject names that don't pre-exist; fields are the primary write-back).
	if err != nil {
		t.Fatalf("tag failure should be best-effort, got err: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 1 || res.TagsWritten != 0 {
		t.Fatalf("result=%+v want matched, 1 field written, 0 tags", res)
	}
	if !mock.sawUpdate {
		t.Fatal("the field update must still have run")
	}
}

func TestZohoWriteProfileNotFound(t *testing.T) {
	mock := &zohoMock{contactID: ""} // 204 no match
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()
	adapter := ZohoWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"token": "z"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "ghost@example.com", Fields: map[string]string{"x": "y"}},
	)
	if err != nil {
		t.Fatalf("a missing contact is not an error: %v", err)
	}
	if res.Matched {
		t.Fatalf("expected unmatched no-op, got %+v", res)
	}
	if mock.sawUpdate {
		t.Fatal("must not update when the contact was not found")
	}
}
