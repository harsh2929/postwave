package listmonk

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"
)

// recordedListmonkBody returns a response body captured verbatim from the
// pinned Listmonk v6.1.0 image (listmonk/listmonk:v6.1.0@sha256:179d00d9…).
func recordedListmonkBody(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "listmonk-v6.1.0", name))
	require.NoError(t, err)
	return bytes.TrimRight(raw, "\n")
}

// wireSubscriber renders sub the way Listmonk v6.1.0 sends a subscriber: the
// recorded create response supplies every key, and each list becomes a list
// object built from the recorded list entry. Test servers answer with this
// rather than with the encoded Go struct, which says lists are ints and so
// agreed with the client whatever the client got wrong.
func wireSubscriber(t *testing.T, sub SubscriberResponse) map[string]any {
	t.Helper()
	var envelope map[string]any
	require.NoError(t, json.Unmarshal(recordedListmonkBody(t, "create_subscriber_with_list.json"), &envelope))
	object := envelope["data"].(map[string]any)
	template := object["lists"].([]any)[0].(map[string]any)
	object["id"] = sub.ID
	object["uuid"] = sub.UUID
	object["email"] = sub.Email
	object["name"] = sub.Name
	object["status"] = sub.Status
	object["attribs"] = sub.Attribs
	if sub.Attribs == nil {
		object["attribs"] = map[string]any{}
	}
	lists := make([]any, 0, len(sub.Lists))
	for _, id := range sub.Lists {
		entry := make(map[string]any, len(template))
		for k, v := range template {
			entry[k] = v
		}
		entry["id"] = id
		entry["name"] = fmt.Sprintf("List %d", id)
		lists = append(lists, entry)
	}
	object["lists"] = lists
	// v6.1.0 has no subscriber tags; the migration keeps them in its own
	// before/after images, so test servers echo them for those assertions.
	object["tags"] = sub.Tags
	return object
}

func wireSubscriberResults(t *testing.T, subs ...SubscriberResponse) map[string]any {
	t.Helper()
	results := make([]any, 0, len(subs))
	for _, sub := range subs {
		results = append(results, wireSubscriber(t, sub))
	}
	return map[string]any{"results": results, "total": len(results)}
}

// Every migration write of a subscriber that has list memberships decoded
// the response into []int and failed after Listmonk had committed it. These
// replay the recorded bytes themselves.
func TestSubscriberReadsDecodeTheRecordedV61Bodies(t *testing.T) {
	for _, tc := range []struct {
		name      string
		recorded  string
		call      func(*Client) (*SubscriberResponse, error)
		wantID    int
		wantLists []int
	}{
		{
			name: "create", recorded: "create_subscriber_with_list.json", wantID: 3, wantLists: []int{3},
			call: func(c *Client) (*SubscriberResponse, error) {
				return c.CreateSubscriber(context.Background(), SubscriberPayload{Email: "diag-1@example.com", Status: "disabled", Lists: []int{3}})
			},
		},
		{
			name: "get", recorded: "patch_subscriber.json", wantID: 3, wantLists: []int{3, 4},
			call: func(c *Client) (*SubscriberResponse, error) { return c.GetSubscriber(context.Background(), 3) },
		},
		{
			name: "find by email", recorded: "query_subscribers.json", wantID: 3, wantLists: []int{3},
			call: func(c *Client) (*SubscriberResponse, error) {
				return c.FindSubscriberByEmailForReconciliation(context.Background(), "diag-1@example.com")
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := recordedListmonkBody(t, tc.recorded)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				_, _ = w.Write(body)
			}))
			t.Cleanup(server.Close)
			got, err := tc.call(&Client{BaseURL: server.URL, HTTPClient: server.Client()})
			require.NoError(t, err, "decoding the recorded v6.1.0 %s body", tc.recorded)
			require.NotNil(t, got)
			lists := append([]int(nil), got.Lists...)
			sort.Ints(lists)
			require.Equal(t, tc.wantID, got.ID)
			require.Equal(t, tc.wantLists, lists)
		})
	}
}

// Before-images stored in Listmonk attribs by earlier migrations hold bare
// ids; they must still read back after the decoder learned list objects.
func TestSubscriberListIDsReadBothShapesAndWriteIDs(t *testing.T) {
	for raw, want := range map[string]SubscriberListIDs{
		`[3,4]`: {3, 4},
		`[{"id":3,"name":"A","subscription_status":"unconfirmed"},{"id":4}]`: {3, 4},
		`[]`:   {},
		`null`: nil,
	} {
		var got SubscriberListIDs
		require.NoError(t, json.Unmarshal([]byte(raw), &got), raw)
		require.True(t, reflect.DeepEqual(want, got), "%s decoded to %#v, want %#v", raw, got, want)
	}
	for _, bad := range []string{`[{"name":"no id"}]`, `["3"]`, `{"id":3}`} {
		var got SubscriberListIDs
		require.Error(t, json.Unmarshal([]byte(bad), &got), bad)
	}
	encoded, err := json.Marshal(SubscriberResponse{ID: 1, Email: "a@example.com", Lists: SubscriberListIDs{3, 4}})
	require.NoError(t, err)
	require.Contains(t, string(encoded), `"lists":[3,4]`)

	snapshot, err := subscriberSnapshotFromAttrib(subscriberSnapshotMap(SubscriberResponse{ID: 9, Email: "a@example.com", Lists: SubscriberListIDs{7}}))
	require.NoError(t, err)
	require.Equal(t, SubscriberListIDs{7}, snapshot.Lists)
}
