// Package twitter ingests a writer's Twitter/X posts from either a user
// archive or the public API v2 user-tweets endpoint.
package twitter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"net/http"
	neturl "net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

const (
	defaultBaseURL  = "https://api.twitter.com/2"
	defaultAPILimit = 100
	maxAPILimit     = 3200

	maxTwitterArchiveBytes int64 = 25 << 20 // Twitter archive tweets.js should be far below this for voice ingestion.
	maxTwitterAPIBytes     int64 = 1 << 20
)

// Source ingests from a Twitter archive file or the API v2 user timeline.
type Source struct {
	HTTPClient  *http.Client
	BaseURL     string
	BearerToken string
}

// New returns a Source configured from process environment.
func New() *Source {
	return &Source{
		HTTPClient:  &http.Client{Timeout: 15 * time.Second},
		BaseURL:     defaultBaseURL,
		BearerToken: strings.TrimSpace(os.Getenv("TWITTER_BEARER_TOKEN")),
	}
}

// Type implements ingest.Source.
func (s *Source) Type() ingest.SourceType { return ingest.SourceTwitter }

// archiveTweet mirrors the per-tweet shape inside tweets.js. The file is
// JavaScript (assignment to `window.YTD.tweets.part0`) so we strip the
// prefix before JSON-decoding.
type archiveTweet struct {
	Tweet struct {
		ID        string `json:"id_str"`
		FullText  string `json:"full_text"`
		CreatedAt string `json:"created_at"`
	} `json:"tweet"`
}

type apiUserResponse struct {
	Data struct {
		ID string `json:"id"`
	} `json:"data"`
}

type apiTweetsResponse struct {
	Data []apiTweet `json:"data"`
	Meta struct {
		NextToken string `json:"next_token"`
	} `json:"meta"`
}

type apiTweet struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}

// Ingest yields Items from either:
//   - params.ArchivePath, pointing at tweets.js from a Twitter archive
//   - params.Extra["mode"]="api", with Extra["user_id"] or Extra["username"]
//
// Archive mode parses Twitter's JavaScript assignment:
//
//	window.YTD.tweets.part0 = [ { "tweet": {...} }, ... ]
func (s *Source) Ingest(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	if err := ingest.ValidateParams(ctx, ingest.SourceTwitter, params); err != nil {
		return nil, err
	}
	params = ingest.NormalizeParams(ingest.SourceTwitter, params)
	mode := strings.ToLower(extra(params, "mode"))
	if mode == "" {
		switch {
		case strings.TrimSpace(params.ArchivePath) != "":
			mode = "archive"
		case extra(params, "user_id") != "" || extra(params, "username") != "":
			mode = "api"
		default:
			mode = "archive"
		}
	}
	switch mode {
	case "archive":
		return s.ingestArchive(ctx, params)
	case "api":
		return s.ingestAPI(ctx, params)
	default:
		return nil, fmt.Errorf("twitter: unsupported mode %q (use archive or api)", mode)
	}
}

func (s *Source) ingestArchive(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	if params.ArchivePath == "" {
		return nil, fmt.Errorf("twitter: ArchivePath required (point at tweets.js from your Twitter archive)")
	}
	raw, err := readArchiveFile(params.ArchivePath)
	if err != nil {
		return nil, fmt.Errorf("twitter: read archive: %w", err)
	}
	jsonStart := bytes.IndexByte(raw, '[')
	if jsonStart == -1 {
		return nil, fmt.Errorf("twitter: archive missing JSON array")
	}
	var tweets []archiveTweet
	if err := json.Unmarshal(raw[jsonStart:], &tweets); err != nil {
		return nil, fmt.Errorf("twitter: decode archive: %w", err)
	}

	limit := params.Limit
	if limit > 0 && len(tweets) > limit {
		tweets = tweets[:limit]
	}

	return func(yield func(ingest.Item, error) bool) {
		for _, t := range tweets {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			// Skip retweets — they aren't the writer's own voice.
			if strings.HasPrefix(t.Tweet.FullText, "RT @") {
				continue
			}
			when, _ := time.Parse(time.RubyDate, t.Tweet.CreatedAt)
			it := ingest.Item{
				ID:          "tweet:" + t.Tweet.ID,
				SourceType:  ingest.SourceTwitter,
				Text:        t.Tweet.FullText,
				PublishedAt: when,
			}
			if !yield(it, nil) {
				return
			}
		}
	}, nil
}

func readArchiveFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, maxTwitterArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxTwitterArchiveBytes {
		return nil, fmt.Errorf("archive exceeds %d bytes", maxTwitterArchiveBytes)
	}
	return raw, nil
}

func (s *Source) ingestAPI(ctx context.Context, params ingest.IngestParams) (iter.Seq2[ingest.Item, error], error) {
	token := strings.TrimSpace(s.BearerToken)
	if token == "" {
		return nil, fmt.Errorf("twitter: TWITTER_BEARER_TOKEN required for api mode")
	}
	userID := extra(params, "user_id")
	var err error
	if userID == "" {
		username := strings.TrimPrefix(extra(params, "username"), "@")
		if username == "" {
			return nil, fmt.Errorf("twitter: api mode requires Extra[\"user_id\"] or Extra[\"username\"]")
		}
		userID, err = s.resolveUsername(ctx, username, token)
		if err != nil {
			return nil, err
		}
	}
	limit := params.Limit
	if limit <= 0 {
		limit = defaultAPILimit
	}
	if limit > maxAPILimit {
		limit = maxAPILimit
	}
	tweets, err := s.fetchTweets(ctx, userID, token, limit)
	if err != nil {
		return nil, err
	}
	return func(yield func(ingest.Item, error) bool) {
		for _, tweet := range tweets {
			if ctx.Err() != nil {
				yield(ingest.Item{}, ctx.Err())
				return
			}
			if strings.TrimSpace(tweet.Text) == "" {
				continue
			}
			when, _ := time.Parse(time.RFC3339, tweet.CreatedAt)
			item := ingest.Item{
				ID:          "tweet:" + tweet.ID,
				SourceType:  ingest.SourceTwitter,
				Text:        tweet.Text,
				PublishedAt: when,
				URL:         "https://x.com/i/web/status/" + tweet.ID,
			}
			if !yield(item, nil) {
				return
			}
		}
	}, nil
}

func (s *Source) resolveUsername(ctx context.Context, username, token string) (string, error) {
	endpoint := s.apiURL("/users/by/username/" + neturl.PathEscape(username))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("twitter: build username request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	var out apiUserResponse
	if err := s.doJSON(req, &out); err != nil {
		return "", err
	}
	if out.Data.ID == "" {
		return "", fmt.Errorf("twitter: username %q resolved without user id", username)
	}
	return out.Data.ID, nil
}

func (s *Source) fetchTweets(ctx context.Context, userID, token string, limit int) ([]apiTweet, error) {
	tweets := make([]apiTweet, 0, min(limit, defaultAPILimit))
	nextToken := ""
	for len(tweets) < limit {
		pageSize := min(100, max(5, limit-len(tweets)))
		u, err := neturl.Parse(s.apiURL("/users/" + neturl.PathEscape(userID) + "/tweets"))
		if err != nil {
			return nil, fmt.Errorf("twitter: build tweets URL: %w", err)
		}
		q := u.Query()
		q.Set("max_results", strconv.Itoa(pageSize))
		q.Set("tweet.fields", "created_at")
		q.Set("exclude", "retweets,replies")
		if nextToken != "" {
			q.Set("pagination_token", nextToken)
		}
		u.RawQuery = q.Encode()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("twitter: build tweets request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)

		var out apiTweetsResponse
		if err := s.doJSON(req, &out); err != nil {
			return nil, err
		}
		tweets = append(tweets, out.Data...)
		if out.Meta.NextToken == "" || len(out.Data) == 0 {
			break
		}
		nextToken = out.Meta.NextToken
	}
	if len(tweets) > limit {
		tweets = tweets[:limit]
	}
	return tweets, nil
}

func (s *Source) doJSON(req *http.Request, dest any) error {
	client := s.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("twitter: api request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("twitter: api returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	if resp.ContentLength > maxTwitterAPIBytes {
		return fmt.Errorf("twitter: decode api response: response body too large")
	}
	if err := decodeJSONLimited(resp.Body, maxTwitterAPIBytes, dest); err != nil {
		return fmt.Errorf("twitter: decode api response: %w", err)
	}
	return nil
}

func decodeJSONLimited(r io.Reader, maxBytes int64, out any) error {
	buf, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return err
	}
	if int64(len(buf)) > maxBytes {
		return fmt.Errorf("response body too large")
	}
	return json.Unmarshal(buf, out)
}

func (s *Source) apiURL(path string) string {
	base := strings.TrimRight(s.BaseURL, "/")
	if base == "" {
		base = defaultBaseURL
	}
	return base + path
}

func extra(params ingest.IngestParams, key string) string {
	if params.Extra == nil {
		return ""
	}
	return strings.TrimSpace(params.Extra[key])
}
