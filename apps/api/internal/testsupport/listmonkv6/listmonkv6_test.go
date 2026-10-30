// SPDX-License-Identifier: AGPL-3.0-only

package listmonkv6

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The recorded bodies are the ground truth every Listmonk test in apps/api
// leans on, so pin what they say in literal terms: a subscriber's lists are
// objects carrying id, name and subscription_status.
func TestRecordedSubscriberBodiesCarryListsAsObjects(t *testing.T) {
	for _, tc := range []struct {
		name   string
		object func(map[string]any) map[string]any
		lists  int
	}{
		{RecordedCreateSubscriberWithList, func(m map[string]any) map[string]any { return m["data"].(map[string]any) }, 1},
		{RecordedQuerySubscribers, func(m map[string]any) map[string]any {
			return m["data"].(map[string]any)["results"].([]any)[0].(map[string]any)
		}, 1},
		{RecordedPatchSubscriber, func(m map[string]any) map[string]any { return m["data"].(map[string]any) }, 2},
		{RecordedPutSubscriber, func(m map[string]any) map[string]any { return m["data"].(map[string]any) }, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sub := tc.object(decodeRecorded(tc.name))
			lists, ok := sub["lists"].([]any)
			if !ok {
				t.Fatalf("lists = %T, want a JSON array", sub["lists"])
			}
			if len(lists) != tc.lists {
				t.Fatalf("recorded %s has %d lists, want %d", tc.name, len(lists), tc.lists)
			}
			for _, entry := range lists {
				list, ok := entry.(map[string]any)
				if !ok {
					t.Fatalf("list entry = %T (%v), want an object", entry, entry)
				}
				for _, key := range []string{"id", "name", "subscription_status"} {
					if _, ok := list[key]; !ok {
						t.Fatalf("list entry has no %q: %v", key, list)
					}
				}
			}
		})
	}
}

// A rendered response must be indistinguishable in shape from the recorded
// one, or tests against this server would stop testing the real wire.
func TestRenderedSubscriberHasTheRecordedShape(t *testing.T) {
	s := NewServer(t)
	s.AddList(3, "A", "single")
	res := post(t, s, "/api/subscribers", `{"email":"shape@example.com","name":"Shape","status":"disabled","lists":[3],"attribs":{"city":"Oslo"}}`)
	if res.status != http.StatusOK {
		t.Fatalf("create status = %d body=%s", res.status, res.body)
	}
	got := decodeObject(t, res.body)["data"].(map[string]any)
	want := decodeRecorded(RecordedCreateSubscriberWithList)["data"].(map[string]any)
	if gotKeys, wantKeys := keys(got), keys(want); !reflect.DeepEqual(gotKeys, wantKeys) {
		t.Fatalf("subscriber keys = %v, recorded = %v", gotKeys, wantKeys)
	}
	gotList := got["lists"].([]any)[0].(map[string]any)
	wantList := want["lists"].([]any)[0].(map[string]any)
	if gotKeys, wantKeys := keys(gotList), keys(wantList); !reflect.DeepEqual(gotKeys, wantKeys) {
		t.Fatalf("list keys = %v, recorded = %v", gotKeys, wantKeys)
	}
	if gotList["subscription_status"] != SubscriptionUnconfirmed || got["status"] != StatusDisabled {
		t.Fatalf("rendered state = %v / %v", got["status"], gotList["subscription_status"])
	}
}

// Captured on the pinned image: PUT {email,status} left the subscriber on no
// lists, PATCH {status} kept both, and a second create for the same address
// answered 409 without touching memberships.
func TestServerReproducesTheCapturedSubscriptionSemantics(t *testing.T) {
	s := NewServer(t)
	s.AddList(3, "A", "single")
	s.AddList(4, "B", "single")
	if res := post(t, s, "/api/subscribers", `{"email":"diag-1@example.com","status":"disabled","lists":[3],"attribs":{"k":"v"}}`); res.status != http.StatusOK {
		t.Fatalf("create = %d %s", res.status, res.body)
	}
	conflict := post(t, s, "/api/subscribers", `{"email":"diag-1@example.com","status":"disabled","lists":[4]}`)
	if conflict.status != http.StatusConflict || !bytes.Equal(conflict.body, Recorded(RecordedCreateSubscriberConflict)) {
		t.Fatalf("re-create = %d %s, want the recorded 409", conflict.status, conflict.body)
	}
	sub, _ := s.Subscriber("diag-1@example.com")
	if !reflect.DeepEqual(sub.Lists, map[int64]string{3: SubscriptionUnconfirmed}) {
		t.Fatalf("memberships after 409 = %v", sub.Lists)
	}

	if res := do(t, s, http.MethodPut, "/api/subscribers/lists", `{"ids":[`+itoa(sub.ID)+`],"action":"add","target_list_ids":[4],"status":"unconfirmed"}`); res.status != http.StatusOK {
		t.Fatalf("add = %d %s", res.status, res.body)
	}
	if res := do(t, s, http.MethodPatch, "/api/subscribers/"+itoa(sub.ID), `{"status":"enabled"}`); res.status != http.StatusOK {
		t.Fatalf("patch = %d %s", res.status, res.body)
	}
	sub, _ = s.Subscriber("diag-1@example.com")
	if want := map[int64]string{3: SubscriptionUnconfirmed, 4: SubscriptionUnconfirmed}; !reflect.DeepEqual(sub.Lists, want) || sub.Status != StatusEnabled {
		t.Fatalf("after PATCH: status %q lists %v, want enabled %v", sub.Status, sub.Lists, want)
	}
	if sub.Attribs["k"] != "v" {
		t.Fatalf("PATCH without attribs dropped them: %v", sub.Attribs)
	}

	// An unsubscribed membership is overwritten by add-with-status.
	do(t, s, http.MethodPut, "/api/subscribers/lists", `{"ids":[`+itoa(sub.ID)+`],"action":"unsubscribe","target_list_ids":[4]}`)
	do(t, s, http.MethodPut, "/api/subscribers/lists", `{"ids":[`+itoa(sub.ID)+`],"action":"add","target_list_ids":[4],"status":"unconfirmed"}`)
	sub, _ = s.Subscriber("diag-1@example.com")
	if sub.Lists[4] != SubscriptionUnconfirmed {
		t.Fatalf("add-with-status left %q, v6.1.0 overwrites unsubscribed", sub.Lists[4])
	}

	put := do(t, s, http.MethodPut, "/api/subscribers/"+itoa(sub.ID), `{"email":"diag-1@example.com","status":"enabled"}`)
	if put.status != http.StatusOK {
		t.Fatalf("put = %d %s", put.status, put.body)
	}
	sub, _ = s.Subscriber("diag-1@example.com")
	if len(sub.Lists) != 0 || len(sub.Attribs) != 0 {
		t.Fatalf("after PUT: lists %v attribs %v, v6.1.0 wipes both", sub.Lists, sub.Attribs)
	}
	if !strings.Contains(string(put.body), `"lists":[]`) {
		t.Fatalf("PUT response = %s, want lists [] as recorded", put.body)
	}
}

func TestCreateWithoutPreconfirmOnADoubleOptinListSendsListmonksOwnOptinMail(t *testing.T) {
	s := NewServer(t)
	post(t, s, "/api/subscribers", `{"email":"a@example.com","status":"disabled","lists":[2],"preconfirm_subscriptions":false}`)
	post(t, s, "/api/subscribers", `{"email":"b@example.com","status":"enabled","lists":[2],"preconfirm_subscriptions":true}`)
	post(t, s, "/api/subscribers", `{"email":"c@example.com","status":"disabled","lists":[1]}`)
	if got := s.OptinMailsSent(); got != 1 {
		t.Fatalf("opt-in mails = %d, want 1 (only the unconfirmed double opt-in create)", got)
	}
}

func TestTransactionalWithoutATemplateIsRejectedAsRecorded(t *testing.T) {
	s := NewServer(t)
	res := post(t, s, "/api/tx", `{"subscriber_email":"a@example.com","subject":"s","body":"b"}`)
	if res.status != http.StatusBadRequest || !bytes.Equal(res.body, Recorded(RecordedTxTemplateNotFound)) {
		t.Fatalf("tx = %d %s", res.status, res.body)
	}
}

type response struct {
	status int
	body   []byte
}

func post(t *testing.T, s *Server, path, body string) response {
	return do(t, s, http.MethodPost, path, body)
}

func do(t *testing.T, s *Server, method, path, body string) response {
	t.Helper()
	req, err := http.NewRequest(method, s.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(res.Body)
	return response{status: res.StatusCode, body: raw}
}

func decodeObject(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return out
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
