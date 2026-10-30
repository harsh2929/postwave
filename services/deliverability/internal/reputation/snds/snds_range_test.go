package snds

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// TestRowCoversTheWholeRange pins the reason this source exists.
//
// SNDS rows describe RANGES. The match used to be `StartIP == ip || EndIP == ip`
// — equality against the two endpoints — so for any range wider than two
// addresses every IP in the middle matched nothing and Fetch fell through to its
// ReputationMedium default. An IP Microsoft had marked Red was reported as
// Medium, which is precisely the signal this client is here to surface.
func TestRowCoversTheWholeRange(t *testing.T) {
	row := Row{StartIP: "192.0.2.10", EndIP: "192.0.2.20", Status: "Red"}

	for _, ip := range []string{"192.0.2.10", "192.0.2.15", "192.0.2.20"} {
		if !row.covers(ip) {
			t.Errorf("%s is inside [%s, %s] but did not match", ip, row.StartIP, row.EndIP)
		}
	}
	// Guard the guard: a matcher that returned true for everything would pass
	// every assertion above.
	for _, ip := range []string{"192.0.2.9", "192.0.2.21", "198.51.100.1"} {
		if row.covers(ip) {
			t.Errorf("%s is outside [%s, %s] but matched", ip, row.StartIP, row.EndIP)
		}
	}
}

func TestRowCoversIsAddressAwareNotStringAware(t *testing.T) {
	row := Row{StartIP: "192.0.2.10", EndIP: "192.0.2.20"}
	// Lexicographic string comparison gets this wrong: "192.0.2.9" sorts AFTER
	// "192.0.2.20", so a string-range check would wrongly include it.
	if row.covers("192.0.2.9") {
		t.Error("192.0.2.9 is below the range but matched")
	}
	// Surrounding whitespace in a feed field must not defeat the match.
	if !row.covers("  192.0.2.15  ") {
		t.Error("a padded but valid address inside the range did not match")
	}
	// A v6 query can never fall inside a v4 range.
	if row.covers("::ffff:192.0.2.15") {
		t.Error("a v6 address matched a v4 range")
	}
	// Malformed input is not a match, and must not panic.
	for _, bad := range []string{"", "not-an-ip", "192.0.2", "999.999.999.999"} {
		if row.covers(bad) {
			t.Errorf("malformed %q matched", bad)
		}
	}
}

// TestTransportErrorDoesNotLeakTheSubscriptionKey covers the other half.
//
// SNDS authenticates by query parameter, so the request URL carries the key,
// and Go reports transport failures as *url.Error whose Error() embeds that
// URL. A timeout used to produce:
//
//	Get "https://...?key=<REAL KEY>": context deadline exceeded
//
// straight into whatever the caller logs. Reputation fetches are scheduled, so
// an outage repeats the line for its whole duration.
func TestTransportErrorDoesNotLeakTheSubscriptionKey(t *testing.T) {
	const key = "SUPER-SECRET-SNDS-KEY"
	c := &Client{Key: key, HTTP: &http.Client{Timeout: 10 * time.Millisecond}}

	_, err := c.Fetch(context.Background(), "example.com", "192.0.2.1")
	if err == nil {
		t.Fatal("expected a transport error")
	}
	if strings.Contains(err.Error(), key) {
		t.Fatalf("the subscription key reached the error text: %s", err.Error())
	}
	// The cause must still be inspectable — scrubbing must not flatten the error
	// into an opaque string.
	if !strings.Contains(err.Error(), "snds: fetch") {
		t.Errorf("error lost its operation context: %s", err.Error())
	}
}

func TestScrubTransportErrorKeepsNonURLErrorsWrapped(t *testing.T) {
	c := &Client{Key: "K"}
	sentinel := errors.New("boom")
	got := c.scrubTransportError(sentinel)
	if !errors.Is(got, sentinel) {
		t.Errorf("a non-url error must stay wrappable, got %v", got)
	}
}

func TestMissingKeyIsRefusedBeforeAnyRequest(t *testing.T) {
	c := &Client{}
	if _, err := c.Fetch(context.Background(), "example.com", "192.0.2.1"); err == nil {
		t.Fatal("expected refusal without a key")
	}
}

func TestParseCSVPopulatesMessageCount(t *testing.T) {
	// MessageCount was declared on Row and never assigned, so it read 0 for
	// every row regardless of the feed.
	rows, err := parseCSV(strings.NewReader(
		"192.0.2.10,192.0.2.20,4211,0.01,0,Green\n" +
			"198.51.100.1,198.51.100.1,notanumber,0.02,1,Red\n",
	))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].MessageCount != 4211 {
		t.Errorf("MessageCount = %d, want 4211", rows[0].MessageCount)
	}
	// A malformed count must not discard the row — the status is the part that
	// matters, and one bad field should not drop a Red.
	if rows[1].MessageCount != 0 || rows[1].Status != "Red" {
		t.Errorf("malformed count row = %+v", rows[1])
	}
}

func TestFetchMapsStatusForAnAddressInsideTheRange(t *testing.T) {
	// End to end: the whole point is that a Red range yields ReputationLow for
	// an address in its middle.
	feed := "192.0.2.10,192.0.2.20,10,0.5,0,Red\n"
	c := &Client{Key: "k", HTTP: &http.Client{Transport: stubTransport(feed)}}
	rep, err := c.Fetch(context.Background(), "example.com", "192.0.2.15")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if rep.MicrosoftScore != domain.ReputationLow {
		t.Errorf("score = %v, want ReputationLow", rep.MicrosoftScore)
	}
}

type stubTransport string

func (s stubTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(string(s))),
		Header:     make(http.Header),
	}, nil
}
