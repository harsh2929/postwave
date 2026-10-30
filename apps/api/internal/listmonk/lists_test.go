// SPDX-License-Identifier: AGPL-3.0-only

package listmonk

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// The fixtures are verbatim Listmonk v6.1.0 responses recorded from a running
// engine (listmonk/listmonk:v6.1.0, GET /api/lists/1 and /api/lists/999999),
// not bodies written to match the decoder.
func serveRecordedList(t *testing.T, status int, fixture string, gotPath *string, gotAuth *bool) *httptest.Server {
	t.Helper()
	body, err := os.ReadFile("testdata/" + fixture)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*gotPath = r.Method + " " + r.URL.Path
		_, _, *gotAuth = r.BasicAuth()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestGetListDecodesTheEngineListByID(t *testing.T) {
	var path string
	var authed bool
	server := serveRecordedList(t, http.StatusOK, "v6.1.0_get_list_200.json", &path, &authed)

	list, err := New(Config{BaseURL: server.URL, Username: "api", Password: "token"}).
		GetList(context.Background(), 1)
	if err != nil {
		t.Fatalf("GetList: %v", err)
	}
	if path != "GET /api/lists/1" {
		t.Fatalf("request = %q, want GET /api/lists/1", path)
	}
	if !authed {
		t.Fatal("GetList did not send the engine credentials")
	}
	if list.ID != 1 || list.Name != "Default list" {
		t.Fatalf("list = %+v, want id 1 named \"Default list\"", list)
	}
}

// Listmonk v6.1.0 reports a missing list as 400, not 404. The caller must see
// an error it can recognise as the engine's refusal, never a zero-value list
// whose empty name would read as "unnamed".
func TestGetListReportsAMissingListAsTheEnginesError(t *testing.T) {
	var path string
	var authed bool
	server := serveRecordedList(t, http.StatusBadRequest, "v6.1.0_get_list_missing_400.json", &path, &authed)

	list, err := New(Config{BaseURL: server.URL}).GetList(context.Background(), 999999)
	if list != nil {
		t.Fatalf("list = %+v, want nil for a missing list", list)
	}
	var upstream *HTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode != http.StatusBadRequest {
		t.Fatalf("err = %v, want the engine's 400 as *HTTPError", err)
	}
}

// A body describing a different list is not an answer to the question asked.
func TestGetListRejectsAResponseForAnotherList(t *testing.T) {
	var path string
	var authed bool
	server := serveRecordedList(t, http.StatusOK, "v6.1.0_get_list_200.json", &path, &authed)

	if _, err := New(Config{BaseURL: server.URL}).GetList(context.Background(), 16); err == nil {
		t.Fatal("GetList(16) accepted the engine's description of list 1")
	}
}

func TestGetListRefusesANonPositiveID(t *testing.T) {
	if _, err := New(Config{BaseURL: "http://127.0.0.1:1"}).GetList(context.Background(), 0); err == nil {
		t.Fatal("GetList(0) did not refuse")
	}
}
