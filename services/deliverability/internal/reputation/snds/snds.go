// Package snds is a skeleton client for Microsoft Smart Network Data Services.
//
// SNDS exposes a CSV feed at:
//
//	https://sendersupport.olc.protection.outlook.com/snds/data.aspx?key=<KEY>
//
// keyed per IP-range subscription. CSV columns:
//
//	start_ip, end_ip, message_count, complaint_rate, trap_count, status,
//	...
package snds

import (
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

// Client is the SNDS adapter.
type Client struct {
	HTTP *http.Client
	Key  string // SNDS subscription key.
}

// New returns a Client.
func New(key string) *Client {
	return &Client{
		HTTP: &http.Client{Timeout: 30 * time.Second},
		Key:  key,
	}
}

// Name implements Source.
func (c *Client) Name() string { return "microsoft_snds" }

// Row is one parsed SNDS CSV row (subset of fields we use).
type Row struct {
	StartIP       string
	EndIP         string
	MessageCount  int
	ComplaintRate string
	Status        string // "Green" | "Yellow" | "Red"
}

// Fetch implements Source. Pulls the CSV, parses, finds the row for `ip`,
// maps its color to ReputationScore.
func (c *Client) Fetch(ctx context.Context, domainName, ip string) (domain.Reputation, error) {
	if c.Key == "" {
		return domain.Reputation{}, errors.New("snds: no key configured")
	}
	url := "https://sendersupport.olc.protection.outlook.com/snds/data.aspx?key=" + c.Key
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return domain.Reputation{}, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return domain.Reputation{}, c.scrubTransportError(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return domain.Reputation{}, fmt.Errorf("snds: status %d", resp.StatusCode)
	}
	rows, err := parseCSV(resp.Body)
	if err != nil {
		return domain.Reputation{}, err
	}
	score := domain.ReputationMedium
	for _, r := range rows {
		if r.covers(ip) {
			switch strings.ToLower(r.Status) {
			case "green":
				score = domain.ReputationHigh
			case "yellow":
				score = domain.ReputationMedium
			case "red":
				score = domain.ReputationLow
			}
			break
		}
	}
	return domain.Reputation{
		Domain:         domainName,
		IP:             ip,
		MicrosoftScore: score,
		CheckedAt:      time.Now(),
	}, nil
}

func parseCSV(r io.Reader) ([]Row, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	rows := []Row{}
	for {
		rec, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(rec) < 6 {
			continue
		}
		rows = append(rows, Row{
			StartIP:       rec[0],
			EndIP:         rec[1],
			MessageCount:  atoi(rec[2]),
			ComplaintRate: rec[3],
			Status:        rec[5],
		})
	}
	return rows, nil
}

// covers reports whether `ip` falls inside this row's [StartIP, EndIP] range.
//
// SNDS rows describe RANGES, and the previous check was `StartIP == ip ||
// EndIP == ip` — equality against the two endpoints. For any range wider than
// two addresses every IP in the middle matched nothing, so Fetch fell through
// to its `ReputationMedium` default. An IP Microsoft had marked **Red** was
// reported as Medium, which is the one direction that matters: the whole point
// of this source is to notice that Microsoft has stopped trusting an address.
//
// Compared as parsed addresses rather than strings, so "1.2.3.4" and
// "001.002.003.004" cannot disagree, and a v4 row can never match a v6 query.
func (r Row) covers(ip string) bool {
	target, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return false
	}
	start, err := netip.ParseAddr(strings.TrimSpace(r.StartIP))
	if err != nil {
		return false
	}
	end, err := netip.ParseAddr(strings.TrimSpace(r.EndIP))
	if err != nil {
		return false
	}
	if target.Is4() != start.Is4() || target.Is4() != end.Is4() {
		return false
	}
	return target.Compare(start) >= 0 && target.Compare(end) <= 0
}

// scrubTransportError strips the subscription key from a transport failure.
//
// SNDS authenticates by query parameter, so the request URL contains the key —
// and Go's http.Client reports failures as *url.Error, whose Error() embeds the
// full URL. A timeout therefore produced:
//
//	Get "https://...snds/data.aspx?key=<REAL KEY>": context deadline exceeded
//
// which goes wherever the caller logs it. Reputation fetches run on a schedule,
// so a Microsoft outage would repeat that line for as long as the outage lasted.
// Unwrapping keeps the cause inspectable with errors.Is/As while dropping the
// URL; the ReplaceAll is a backstop for any error type that is not *url.Error.
func (c *Client) scrubTransportError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return fmt.Errorf("snds: fetch: %w", urlErr.Err)
	}
	if c.Key != "" && strings.Contains(err.Error(), c.Key) {
		return fmt.Errorf("snds: fetch: %s", strings.ReplaceAll(err.Error(), c.Key, "[REDACTED]"))
	}
	return fmt.Errorf("snds: fetch: %w", err)
}

// atoi returns 0 for an unparseable count rather than failing the whole feed;
// MessageCount is advisory, and one malformed row should not discard the rest.
func atoi(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}
