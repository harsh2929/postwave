// Package senderscore queries the public SenderScore DNS feed.
//
// SenderScore returns a 0..100 reputation per IP. The public DNS lookup
// variant queries <reversed-ip>.score.senderscore.com and reads the score from
// the last octet in a 127.0.x.<score> answer.
package senderscore

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

type Resolver interface {
	LookupHost(context.Context, string) ([]string, error)
}

// Client is the SenderScore adapter.
type Client struct {
	HTTP         *http.Client
	APIKey       string
	Resolver     Resolver
	LookupSuffix string
	Now          func() time.Time
}

// New returns a Client.
func New(key string) *Client {
	return &Client{
		HTTP:         &http.Client{Timeout: 15 * time.Second},
		APIKey:       key,
		Resolver:     netResolver{},
		LookupSuffix: "score.senderscore.com",
		Now:          time.Now,
	}
}

// Name implements Source.
func (c *Client) Name() string { return "senderscore" }

// Fetch returns a Reputation populated only with SenderScore. The APIKey field
// is retained for config compatibility, but the implementation uses the public
// DNS feed so it can run without a paid API adapter.
func (c *Client) Fetch(ctx context.Context, domainName, ip string) (domain.Reputation, error) {
	host, err := lookupHost(ip, c.LookupSuffix)
	if err != nil {
		return domain.Reputation{}, err
	}
	resolver := c.Resolver
	if resolver == nil {
		resolver = netResolver{}
	}
	records, err := resolver.LookupHost(ctx, host)
	if err != nil {
		return domain.Reputation{}, err
	}
	score, err := parseScore(records)
	if err != nil {
		return domain.Reputation{}, err
	}
	return domain.Reputation{
		Domain:      domainName,
		IP:          ip,
		SenderScore: score,
		CheckedAt:   c.now(),
	}, nil
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func lookupHost(ip, suffix string) (string, error) {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil || !addr.Is4() {
		return "", errors.New("senderscore: IPv4 address required")
	}
	octets := addr.As4()
	suffix = strings.Trim(strings.TrimSpace(suffix), ".")
	if suffix == "" {
		suffix = "score.senderscore.com"
	}
	return strings.Join([]string{
		strconv.Itoa(int(octets[3])),
		strconv.Itoa(int(octets[2])),
		strconv.Itoa(int(octets[1])),
		strconv.Itoa(int(octets[0])),
		suffix,
	}, "."), nil
}

func parseScore(records []string) (int, error) {
	for _, record := range records {
		addr, err := netip.ParseAddr(strings.TrimSpace(record))
		if err != nil || !addr.Is4() {
			continue
		}
		octets := addr.As4()
		score := int(octets[3])
		if score >= 0 && score <= 100 {
			return score, nil
		}
	}
	return 0, errors.New("senderscore: score not found")
}

type netResolver struct{}

func (netResolver) LookupHost(ctx context.Context, host string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, host)
}
