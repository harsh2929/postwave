// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/pagination"
)

func TestInboundPageEnvelopeUsesExactSnakeCaseWireContract(t *testing.T) {
	raw, err := json.Marshal(inboundPageEnvelope[string]{
		Items:      []string{"one"},
		NextCursor: "cursor-token",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(raw), `{"items":["one"],"next_cursor":"cursor-token"}`; got != want {
		t.Fatalf("non-terminal page = %s, want %s", got, want)
	}
	if strings.Contains(string(raw), "nextCursor") {
		t.Fatalf("legacy camelCase cursor leaked into inbound wire: %s", raw)
	}

	raw, err = json.Marshal(inboundPageEnvelope[string]{Items: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(raw), `{"items":[]}`; got != want {
		t.Fatalf("terminal page = %s, want %s", got, want)
	}
}

func TestListEventsRejectsMalformedParentBeforeDatabaseUse(t *testing.T) {
	repo := &Repo{}
	if _, _, err := repo.ListEventsPage(
		t.Context(),
		"tenant",
		"not-a-uuid",
		50,
		pagination.Cursor{},
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ListEventsPage error = %v, want ErrNotFound before DB use", err)
	}
}

func TestInboundEventBodyProjectionFailsClosedOnInvalidUTF8(t *testing.T) {
	if got := projectInboundEventBody([]byte(`{"ok":true}`)); got != `{"ok":true}` {
		t.Fatalf("valid body projection = %q", got)
	}
	if got := projectInboundEventBody([]byte{'{', 0xff, '}'}); got != "" {
		t.Fatalf("invalid UTF-8 body projection = %q, want empty", got)
	}
}
