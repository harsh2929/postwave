package socialads

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

var metaDocs = []string{
	"https://developers.facebook.com/docs/pages-api/posts/",
	"https://developers.facebook.com/docs/instagram-platform/content-publishing/",
}

type MetaConfig struct {
	GraphBaseURL               string
	GraphVersion               string
	PageID                     string
	PageAccessToken            string
	InstagramBusinessAccountID string
	AdAccountID                string
	AdsAccessToken             string
}

type MetaProvider struct {
	cfg    MetaConfig
	client *http.Client
}

func MetaConfigFromConfig(cfg Config) MetaConfig {
	return MetaConfig{
		GraphBaseURL:               cfg.MetaGraphBaseURL,
		GraphVersion:               cfg.MetaGraphVersion,
		PageID:                     cfg.MetaPageID,
		PageAccessToken:            cfg.MetaPageAccessToken,
		InstagramBusinessAccountID: cfg.MetaInstagramBusinessAccountID,
		AdAccountID:                cfg.MetaAdAccountID,
		AdsAccessToken:             cfg.MetaAdsAccessToken,
	}
}

func NewMetaProvider(cfg MetaConfig, client *http.Client) *MetaProvider {
	if client == nil {
		client = http.DefaultClient
	}
	cfg.GraphBaseURL = strings.TrimRight(trim(cfg.GraphBaseURL), "/")
	if cfg.GraphBaseURL == "" {
		cfg.GraphBaseURL = DefaultMetaGraphBaseURL
	}
	if trim(cfg.GraphVersion) == "" {
		cfg.GraphVersion = DefaultMetaGraphVersion
	}
	return &MetaProvider{cfg: cfg, client: client}
}

func (p *MetaProvider) PageReadiness() ProviderStatus {
	missing := missingFields(map[string]string{
		"META_PAGE_ID":           p.cfg.PageID,
		"META_PAGE_ACCESS_TOKEN": p.cfg.PageAccessToken,
	})
	if len(missing) > 0 {
		st := notConfiguredStatus("meta_pages", missing, "Facebook Page publishing requires a Page ID and Page access token with Page publishing permissions.")
		st.Docs = metaDocs
		st.Version = p.cfg.GraphVersion
		return st
	}
	return configuredStatus("meta_pages", "Facebook Page publishing is configured for Graph API feed/photos publishing.", p.cfg.GraphVersion, metaDocs)
}

func (p *MetaProvider) InstagramReadiness() ProviderStatus {
	missing := missingFields(map[string]string{
		"META_INSTAGRAM_BUSINESS_ACCOUNT_ID": p.cfg.InstagramBusinessAccountID,
		"META_PAGE_ACCESS_TOKEN":             p.cfg.PageAccessToken,
	})
	if len(missing) > 0 {
		st := notConfiguredStatus("meta_instagram", missing, "Instagram publishing requires an Instagram Business/Creator account connected to Meta Graph plus a Page access token.")
		st.Docs = metaDocs
		st.Version = p.cfg.GraphVersion
		return st
	}
	return configuredStatus("meta_instagram", "Instagram content publishing is configured for media-container then media_publish flow.", p.cfg.GraphVersion, metaDocs)
}

func (p *MetaProvider) AdsReadiness() ProviderStatus {
	missing := missingFields(map[string]string{
		"META_AD_ACCOUNT_ID":    p.cfg.AdAccountID,
		"META_ADS_ACCESS_TOKEN": p.cfg.AdsAccessToken,
	})
	if len(missing) > 0 {
		st := notConfiguredStatus("meta_ads", missing, "Meta Ads buying/report sync requires an ad account ID and ads access token.")
		st.Docs = []string{"https://developers.facebook.com/docs/marketing-apis/"}
		st.Version = p.cfg.GraphVersion
		return st
	}
	return configuredStatus("meta_ads", "Meta Ads credentials are present; campaign buying remains gated behind the dedicated ads mutation worker.", p.cfg.GraphVersion, []string{"https://developers.facebook.com/docs/marketing-apis/"})
}

func (p *MetaProvider) PublishSocial(ctx context.Context, req SocialPostRequest) (ProviderResult, error) {
	switch strings.ToLower(strings.TrimSpace(req.Network)) {
	case "instagram", "ig":
		return p.publishInstagram(ctx, req)
	default:
		return p.publishFacebook(ctx, req)
	}
}

func (p *MetaProvider) publishFacebook(ctx context.Context, req SocialPostRequest) (ProviderResult, error) {
	if len(p.PageReadiness().Missing) > 0 {
		return ProviderResult{Provider: "meta_pages", Status: "requires_provider"}, fmt.Errorf("%w: missing %s", ErrNotConfigured, strings.Join(p.PageReadiness().Missing, ", "))
	}
	if len(req.MediaURLs) > 0 {
		values := url.Values{
			"url":          {req.MediaURLs[0]},
			"caption":      {req.Text},
			"access_token": {p.cfg.PageAccessToken},
		}
		body, err := p.postForm(ctx, fmt.Sprintf("/%s/photos", req.AccountIDOrDefault(p.cfg.PageID)), values)
		if err != nil {
			return ProviderResult{Provider: "meta_pages", Status: "error"}, err
		}
		id := stringFromBody(body, "post_id")
		if id == "" {
			id = stringFromBody(body, "id")
		}
		return ProviderResult{Provider: "meta_pages", Status: "published", ProviderID: id, Message: "Published Facebook Page photo post.", Raw: body}, nil
	}
	values := url.Values{
		"message":      {req.Text},
		"access_token": {p.cfg.PageAccessToken},
	}
	if strings.TrimSpace(req.LinkURL) != "" {
		values.Set("link", strings.TrimSpace(req.LinkURL))
	}
	body, err := p.postForm(ctx, fmt.Sprintf("/%s/feed", req.AccountIDOrDefault(p.cfg.PageID)), values)
	if err != nil {
		return ProviderResult{Provider: "meta_pages", Status: "error"}, err
	}
	return ProviderResult{Provider: "meta_pages", Status: "published", ProviderID: stringFromBody(body, "id"), Message: "Published Facebook Page feed post.", Raw: body}, nil
}

func (p *MetaProvider) publishInstagram(ctx context.Context, req SocialPostRequest) (ProviderResult, error) {
	if len(p.InstagramReadiness().Missing) > 0 {
		return ProviderResult{Provider: "meta_instagram", Status: "requires_provider"}, fmt.Errorf("%w: missing %s", ErrNotConfigured, strings.Join(p.InstagramReadiness().Missing, ", "))
	}
	if len(req.MediaURLs) == 0 || strings.TrimSpace(req.MediaURLs[0]) == "" {
		return ProviderResult{Provider: "meta_instagram", Status: "blocked"}, fmt.Errorf("instagram publishing requires a public media URL")
	}
	accountID := req.AccountIDOrDefault(p.cfg.InstagramBusinessAccountID)
	createValues := url.Values{
		"image_url":    {req.MediaURLs[0]},
		"caption":      {req.Text},
		"access_token": {p.cfg.PageAccessToken},
	}
	container, err := p.postForm(ctx, fmt.Sprintf("/%s/media", accountID), createValues)
	if err != nil {
		return ProviderResult{Provider: "meta_instagram", Status: "error"}, err
	}
	creationID := stringFromBody(container, "id")
	if creationID == "" {
		return ProviderResult{Provider: "meta_instagram", Status: "error", Raw: container}, fmt.Errorf("meta instagram media container response did not include id")
	}
	publishValues := url.Values{
		"creation_id":  {creationID},
		"access_token": {p.cfg.PageAccessToken},
	}
	published, err := p.postForm(ctx, fmt.Sprintf("/%s/media_publish", accountID), publishValues)
	if err != nil {
		return ProviderResult{Provider: "meta_instagram", Status: "error"}, err
	}
	return ProviderResult{Provider: "meta_instagram", Status: "published", ProviderID: stringFromBody(published, "id"), Message: "Published Instagram media post.", Raw: published}, nil
}

func (p *MetaProvider) postForm(ctx context.Context, endpoint string, values url.Values) (map[string]any, error) {
	u := fmt.Sprintf("%s/%s%s", p.cfg.GraphBaseURL, strings.Trim(p.cfg.GraphVersion, "/"), endpoint)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	return decodeProviderResponse(resp)
}

func decodeProviderResponse(resp *http.Response) (map[string]any, error) {
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	payload := map[string]any{}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &payload)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return payload, providerHTTPError(resp.StatusCode, payload, string(body))
	}
	return payload, nil
}

func providerHTTPError(status int, payload map[string]any, raw string) error {
	if errPayload, ok := payload["error"].(map[string]any); ok {
		if msg, ok := errPayload["message"].(string); ok && strings.TrimSpace(msg) != "" {
			return fmt.Errorf("provider returned HTTP %d: %s", status, msg)
		}
	}
	if strings.TrimSpace(raw) != "" {
		return fmt.Errorf("provider returned HTTP %d: %s", status, raw)
	}
	return fmt.Errorf("provider returned HTTP %d", status)
}

func stringFromBody(body map[string]any, key string) string {
	if v, ok := body[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func missingFields(fields map[string]string) []string {
	missing := []string{}
	for k, v := range fields {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, k)
		}
	}
	sort.Strings(missing)
	return missing
}

func (r SocialPostRequest) AccountIDOrDefault(fallback string) string {
	if strings.TrimSpace(r.AccountID) != "" {
		return strings.TrimSpace(r.AccountID)
	}
	return strings.TrimSpace(fallback)
}
