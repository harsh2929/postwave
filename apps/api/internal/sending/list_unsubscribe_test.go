package sending

import (
	"context"
	"strings"
	"testing"
)

// TestRenderUnsubscribePlaceholderReplacesCommonVariants confirms the
// renderer substitutes the placeholders the templates actually use.
func TestRenderUnsubscribePlaceholderReplacesCommonVariants(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{`<a href="{{ unsubscribe_url }}">Unsubscribe</a>`, true},
		{`<a href="{{unsubscribe_url}}">Unsubscribe</a>`, true},
		{`<a href="{{ Unsubscribe.URL }}">Unsubscribe</a>`, true},
		{`<a href="{{UnsubscribeURL}}">Unsubscribe</a>`, true},
		// Spellings the compliance gate accepts must render too; before the
		// shared definition these two passed the gate and reached recipients
		// as a literal, unclickable token.
		{`<a href="{{Unsubscribe.URL}}">Unsubscribe</a>`, true},
		{`<a href="{{  unsubscribe_url  }}">Unsubscribe</a>`, true},
		{`<a href="https://static/unsub">Unsubscribe</a>`, false},
	}
	url := "https://app.example.com/preferences/abcdef"
	for _, c := range cases {
		got := RenderUnsubscribePlaceholder(c.in, url)
		contains := strings.Contains(got, url)
		if contains != c.want {
			t.Errorf("RenderUnsubscribePlaceholder(%q) contains url=%v, want %v; got=%q",
				c.in, contains, c.want, got)
		}
	}
}

// TestRenderUnsubscribePlaceholderEmptyURLIsNoOp prevents accidental
// blanking of the body when the builder fails to mint.
func TestRenderUnsubscribePlaceholderEmptyURLIsNoOp(t *testing.T) {
	in := `<a href="{{ unsubscribe_url }}">x</a>`
	if got := RenderUnsubscribePlaceholder(in, ""); got != in {
		t.Fatalf("got %q, want unchanged", got)
	}
}

// TestExtractFirstURLPullsHTTPSFromHeaderValue is the happy path.
func TestExtractFirstURLPullsHTTPSFromHeaderValue(t *testing.T) {
	v := "<https://app.example.com/preferences/abc>, <mailto:u@e.com?subject=unsubscribe>"
	got, ok := extractFirstURL(v)
	if !ok {
		t.Fatalf("extractFirstURL failed; v=%q", v)
	}
	if got != "https://app.example.com/preferences/abc" {
		t.Fatalf("got %q", got)
	}
}

// TestExtractFirstURLRejectsMailtoOnlyHeader: an https URL is what we
// want to render in the body; a header that lists ONLY a mailto:
// target should not produce a body substitution.
func TestExtractFirstURLRejectsMailtoOnlyHeader(t *testing.T) {
	if _, ok := extractFirstURL("<mailto:u@e.com>"); ok {
		t.Fatalf("mailto-only header should not yield a body URL")
	}
}

// TestExtractFirstURLHandlesBrokenInput protects against parser
// crashes on malformed values.
func TestExtractFirstURLHandlesBrokenInput(t *testing.T) {
	for _, v := range []string{"", "no brackets", "<unterminated", "><reversed"} {
		if _, ok := extractFirstURL(v); ok {
			t.Fatalf("malformed value %q should not parse", v)
		}
	}
}

func TestOneClickAndHumanPreferenceURLsUseTheSameToken(t *testing.T) {
	oneClick := oneClickEndpointURL("https://app.example.com/", "abc123")
	if want := "https://app.example.com/api/public/preferences/abc123/one-click"; oneClick != want {
		t.Fatalf("one-click URL = %q, want %q", oneClick, want)
	}
	if got, want := preferenceCenterURL(oneClick), "https://app.example.com/preferences/abc123"; got != want {
		t.Fatalf("preference center URL = %q, want %q", got, want)
	}
}

// TestListUnsubscribeBuilderEmptyBaseURLReturnsNilHeaders ensures the
// builder is a no-op when the operator hasn't configured a public
// base URL — the send loop falls back to the no-headers path.
func TestListUnsubscribeBuilderEmptyBaseURLReturnsNilHeaders(t *testing.T) {
	b := &ListUnsubscribeBuilder{PublicBaseURL: ""}
	h, err := b.Headers(context.Background(), "tenant-1", "a@example.com")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if h != nil {
		t.Fatalf("expected nil headers; got %v", h)
	}
}

// TestListUnsubscribeBuilderNilReceiverIsSafe protects callers that
// share the Guard with nil-builder code paths (legacy tests, etc).
func TestListUnsubscribeBuilderNilReceiverIsSafe(t *testing.T) {
	var b *ListUnsubscribeBuilder
	h, err := b.Headers(context.Background(), "tenant-1", "a@example.com")
	if err != nil {
		t.Fatalf("nil receiver should not error; got %v", err)
	}
	if h != nil {
		t.Fatalf("nil receiver should produce nil headers; got %v", h)
	}
	u, uerr := b.OneClickURL(context.Background(), "tenant-1", "a@example.com")
	if uerr != nil || u != "" {
		t.Fatalf("OneClickURL: u=%q err=%v", u, uerr)
	}
}

// TestRandomHexUniquePerCall covers the token-source surface so a
// future refactor doesn't accidentally drop the crypto/rand call.
func TestRandomHexUniquePerCall(t *testing.T) {
	a, err := randomHex(32)
	if err != nil {
		t.Fatal(err)
	}
	b, err := randomHex(32)
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatalf("two calls produced identical tokens: %s", a)
	}
	if len(a) != 64 {
		t.Fatalf("len(token) = %d, want 64", len(a))
	}
}
