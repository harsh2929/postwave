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

type wooMock struct {
	gotAuthUser string
	customerID  int // returned by the customer search; 0 = not found
	sawUpdate   bool
	updateMeta  []map[string]any
}

func (m *wooMock) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, _, _ := r.BasicAuth()
		m.gotAuthUser = user
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/customers"):
			if m.customerID == 0 {
				_, _ = w.Write([]byte(`[]`))
				return
			}
			email := r.URL.Query().Get("email")
			_, _ = w.Write([]byte(`[{"id":` + itoa(m.customerID) + `,"email":"` + email + `"}]`))
		case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/customers/"):
			m.sawUpdate = true
			var in struct {
				MetaData []map[string]any `json:"meta_data"`
			}
			_ = json.Unmarshal(body, &in)
			m.updateMeta = in.MetaData
			_, _ = w.Write([]byte(`{"id":` + itoa(m.customerID) + `}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func TestWooCommerceWriteProfile(t *testing.T) {
	mock := &wooMock{customerID: 77}
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()

	adapter := WooCommerceWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"consumer_key": "ck_x", "consumer_secret": "cs_y"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "Buyer@Example.com", Tags: []string{"VIP", "Newsletter"}, Fields: map[string]string{"clv_tier": "gold"}},
	)
	if err != nil {
		t.Fatalf("WriteProfile: %v", err)
	}
	if !res.Matched || res.FieldsWritten != 1 || res.TagsWritten != 2 {
		t.Fatalf("result=%+v", res)
	}
	if mock.gotAuthUser != "ck_x" {
		t.Fatalf("basic-auth consumer key not sent: %q", mock.gotAuthUser)
	}
	if !mock.sawUpdate {
		t.Fatal("expected a customer update")
	}
	// meta_data must carry the field plus the tags-as-segments entry.
	byKey := map[string]any{}
	for _, m := range mock.updateMeta {
		byKey[m["key"].(string)] = m["value"]
	}
	if byKey["clv_tier"] != "gold" {
		t.Fatalf("field not written to meta_data: %+v", mock.updateMeta)
	}
	if byKey["postwave_segments"] != "VIP,Newsletter" {
		t.Fatalf("tags not written as segments meta: %+v", mock.updateMeta)
	}
}

func TestWooCommerceWriteProfileNotFound(t *testing.T) {
	mock := &wooMock{customerID: 0} // no match
	srv := httptest.NewServer(mock.handler())
	defer srv.Close()
	adapter := WooCommerceWritebackAdapter{HTTPClient: srv.Client()}
	res, err := adapter.WriteProfile(context.Background(),
		map[string]string{"consumer_key": "ck", "consumer_secret": "cs"},
		map[string]any{"api_base_url": srv.URL},
		ProfileWrite{Email: "ghost@example.com", Fields: map[string]string{"x": "y"}},
	)
	if err != nil {
		t.Fatalf("a missing customer is not an error: %v", err)
	}
	if res.Matched {
		t.Fatalf("expected unmatched no-op, got %+v", res)
	}
	if mock.sawUpdate {
		t.Fatal("must not update when the customer was not found")
	}
}
