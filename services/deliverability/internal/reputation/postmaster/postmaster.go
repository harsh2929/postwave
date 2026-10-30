// Package postmaster is a client for Google Postmaster Tools API.
//
// Endpoint: https://gmailpostmastertools.googleapis.com/v1/domains/<domain>/trafficStats
// Auth: OAuth2 service-account or end-user token.
package postmaster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

const postmasterMaxResponseBytes int64 = 1 << 20

// Client is the Postmaster Tools adapter.
type Client struct {
	HTTP       *http.Client
	OAuthToken string // bearer token; production must refresh via OAuth2 flow.
	UserAgent  string
	BaseURL    string
	Now        func() time.Time
}

// New returns a Client with sane defaults.
func New(token string) *Client {
	return &Client{
		HTTP:       &http.Client{Timeout: 15 * time.Second},
		OAuthToken: token,
		UserAgent:  "postwave-deliverability/0.1",
		BaseURL:    "https://gmailpostmastertools.googleapis.com/v1",
		Now:        time.Now,
	}
}

// Name implements Source.
func (c *Client) Name() string { return "google_postmaster" }

// Fetch implements Source by reading the latest trafficStats item and mapping
// Google's reputation buckets onto Moosewave's coarse score.
func (c *Client) Fetch(ctx context.Context, domainName, _ string) (domain.Reputation, error) {
	if c.OAuthToken == "" {
		return domain.Reputation{}, errors.New("postmaster: no OAuth token configured")
	}
	endpoint, err := c.trafficStatsURL(domainName)
	if err != nil {
		return domain.Reputation{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return domain.Reputation{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.OAuthToken)
	if strings.TrimSpace(c.UserAgent) != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return domain.Reputation{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return domain.Reputation{}, fmt.Errorf("postmaster: status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out trafficStatsResponse
	if resp.ContentLength > postmasterMaxResponseBytes {
		return domain.Reputation{}, errors.New("postmaster: response body too large")
	}
	if err := decodeJSONLimited(resp.Body, postmasterMaxResponseBytes, &out); err != nil {
		return domain.Reputation{}, err
	}
	stat, ok := latestStat(out.TrafficStats)
	if !ok {
		return domain.Reputation{}, errors.New("postmaster: no trafficStats returned")
	}
	return domain.Reputation{
		Domain:      domainName,
		GoogleScore: scoreFromStat(stat),
		CheckedAt:   c.now(),
	}, nil
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return errors.New("postmaster: response body too large")
	}
	return json.Unmarshal(buf, out)
}

func (c *Client) trafficStatsURL(domainName string) (string, error) {
	baseRaw := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if baseRaw == "" {
		baseRaw = "https://gmailpostmastertools.googleapis.com/v1"
	}
	base, err := url.Parse(baseRaw)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid postmaster base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported postmaster base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe postmaster base URL")
	}
	domainName = strings.TrimSpace(domainName)
	if domainName == "" {
		return "", fmt.Errorf("postmaster domain required")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/domains/" + url.PathEscape(domainName) + "/trafficStats"
	return base.String(), nil
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

type trafficStatsResponse struct {
	TrafficStats []trafficStat `json:"trafficStats"`
}

type trafficStat struct {
	Name                  string         `json:"name"`
	StartDate             googleDate     `json:"startDate"`
	DomainReputation      string         `json:"domainReputation"`
	IPReputations         []ipReputation `json:"ipReputations"`
	UserReportedSpamRatio float64        `json:"userReportedSpamRatio"`
	SpamRate              float64        `json:"spamRate"`
}

type googleDate struct {
	Year  int `json:"year"`
	Month int `json:"month"`
	Day   int `json:"day"`
}

type ipReputation struct {
	Reputation string   `json:"reputation"`
	IPs        []string `json:"ips"`
}

func latestStat(stats []trafficStat) (trafficStat, bool) {
	if len(stats) == 0 {
		return trafficStat{}, false
	}
	latest := stats[0]
	for _, stat := range stats[1:] {
		if stat.StartDate.after(latest.StartDate) {
			latest = stat
		}
	}
	return latest, true
}

func (d googleDate) after(other googleDate) bool {
	if d.Year != other.Year {
		return d.Year > other.Year
	}
	if d.Month != other.Month {
		return d.Month > other.Month
	}
	return d.Day > other.Day
}

func scoreFromStat(stat trafficStat) domain.ReputationScore {
	if score := scoreFromGoogleBucket(stat.DomainReputation); score != "" {
		return score
	}
	if len(stat.IPReputations) > 0 {
		lowest := domain.ReputationHigh
		for _, ipRep := range stat.IPReputations {
			score := scoreFromGoogleBucket(ipRep.Reputation)
			if score == domain.ReputationLow {
				return domain.ReputationLow
			}
			if score == domain.ReputationMedium {
				lowest = domain.ReputationMedium
			}
		}
		return lowest
	}
	spamRate := stat.UserReportedSpamRatio
	if stat.SpamRate > spamRate {
		spamRate = stat.SpamRate
	}
	switch {
	case spamRate >= 0.02:
		return domain.ReputationLow
	case spamRate >= 0.005:
		return domain.ReputationMedium
	default:
		return domain.ReputationHigh
	}
}

func scoreFromGoogleBucket(bucket string) domain.ReputationScore {
	switch strings.ToUpper(strings.TrimSpace(bucket)) {
	case "HIGH":
		return domain.ReputationHigh
	case "MEDIUM":
		return domain.ReputationMedium
	case "LOW", "BAD":
		return domain.ReputationLow
	default:
		return ""
	}
}
