// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func decodeManualRequest(t *testing.T, body string) (manualReplyRequest, error) {
	t.Helper()
	var request manualReplyRequest
	err := json.Unmarshal([]byte(body), &request)
	if err != nil {
		return request, err
	}
	return request, request.validate()
}

func TestManualReplyRequestRequiresASenderAndABody(t *testing.T) {
	for name, body := range map[string]string{
		"no sender":       `{"body":"thanks!"}`,
		"blank sender":    `{"recipient_email":"   ","body":"thanks!"}`,
		"not an address":  `{"recipient_email":"not-an-address","body":"thanks!"}`,
		"no body":         `{"recipient_email":"reader@example.test"}`,
		"blank body":      `{"recipient_email":"reader@example.test","body":"   "}`,
		"received_at bad": `{"recipient_email":"reader@example.test","body":"hi","received_at":"yesterday"}`,
	} {
		if _, err := decodeManualRequest(t, body); err == nil {
			t.Fatalf("%s: accepted an invalid manual reply", name)
		}
	}
	if _, err := decodeManualRequest(t, `{"recipient_email":"reader@example.test","body":"thanks!"}`); err != nil {
		t.Fatalf("rejected a valid manual reply: %v", err)
	}
}

// The operator supplies a body and a sender; everything that decides whether
// this counts as engagement is set here, not by the caller. A request that
// could name its own classification or match method would let a tenant mint
// human-engagement evidence by hand.
func TestManualReplyIgnoresCallerSuppliedClassificationAndCorrelation(t *testing.T) {
	request, err := decodeManualRequest(t, `{
        "recipient_email":"reader@example.test",
        "body":"thanks!",
        "classification":"human_reply",
        "match_method":"verp",
        "source":"postmark"
    }`)
	if err != nil {
		t.Fatal(err)
	}
	reply := request.toReply("campaign-id", "operator@team.test")
	if reply.Source != SourceManual {
		t.Fatalf("source is caller-controlled: %q", reply.Source)
	}
	if reply.MatchMethod != MatchManual {
		t.Fatalf("match method is caller-controlled: %q", reply.MatchMethod)
	}
	if reply.Classification != "" {
		t.Fatalf("caller pre-classified the reply as %q; Store.Persist must classify",
			reply.Classification)
	}
}

// Provenance is the whole point of a manual row. Without the operator on the
// record, a hand-entered reply is indistinguishable from an observed one.
func TestManualReplyRecordsTheAssertingOperator(t *testing.T) {
	request, err := decodeManualRequest(t, `{"recipient_email":"reader@example.test","body":"thanks!"}`)
	if err != nil {
		t.Fatal(err)
	}
	reply := request.toReply("campaign-id", "operator@team.test")
	var metadata map[string]any
	if err := json.Unmarshal(reply.Metadata, &metadata); err != nil {
		t.Fatalf("metadata is not a JSON object: %v", err)
	}
	entry, ok := metadata["manual_entry"].(map[string]any)
	if !ok {
		t.Fatalf("no manual_entry provenance in %s", reply.Metadata)
	}
	if entry["recorded_by"] != "operator@team.test" {
		t.Fatalf("operator identity missing: %v", entry)
	}
	if entry["asserted"] != true {
		t.Fatalf("manual rows must be marked as asserted rather than observed: %v", entry)
	}
}

func TestManualReplyEndpointRejectsAnUnparseableBody(t *testing.T) {
	deps := &Deps{}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost,
		"/api/v1/campaigns/11111111-1111-4111-8111-111111111111/replies/manual",
		strings.NewReader("{not json"))
	deps.HandleManualReply(recorder, request)
	if recorder.Code != http.StatusBadRequest && recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unparseable body returned %d", recorder.Code)
	}
}
