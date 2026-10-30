package socialads

import (
	"context"
	"net/http"
	"strings"
	"time"
)

const (
	DefaultMetaGraphBaseURL    = "https://graph.facebook.com"
	DefaultMetaGraphVersion    = "v24.0"
	DefaultGoogleAdsAPIBase    = "https://googleads.googleapis.com"
	DefaultGoogleAdsVersion    = "v24"
	DefaultGoogleOAuthTokenURL = "https://www.googleapis.com/oauth2/v3/token"
)

type Config struct {
	MetaGraphBaseURL               string
	MetaGraphVersion               string
	MetaPageID                     string
	MetaPageAccessToken            string
	MetaInstagramBusinessAccountID string
	MetaAdAccountID                string
	MetaAdsAccessToken             string
	GoogleAdsAPIBaseURL            string
	GoogleAdsAPIVersion            string
	GoogleAdsDeveloperToken        string
	GoogleAdsClientID              string
	GoogleAdsClientSecret          string
	GoogleAdsRefreshToken          string
	GoogleAdsLoginCustomerID       string
	GoogleAdsCustomerID            string
	GoogleOAuthTokenURL            string
}

func (c Config) WithDefaults() Config {
	if strings.TrimSpace(c.MetaGraphBaseURL) == "" {
		c.MetaGraphBaseURL = DefaultMetaGraphBaseURL
	}
	if strings.TrimSpace(c.MetaGraphVersion) == "" {
		c.MetaGraphVersion = DefaultMetaGraphVersion
	}
	if strings.TrimSpace(c.GoogleAdsAPIBaseURL) == "" {
		c.GoogleAdsAPIBaseURL = DefaultGoogleAdsAPIBase
	}
	if strings.TrimSpace(c.GoogleAdsAPIVersion) == "" {
		c.GoogleAdsAPIVersion = DefaultGoogleAdsVersion
	}
	if strings.TrimSpace(c.GoogleOAuthTokenURL) == "" {
		c.GoogleOAuthTokenURL = DefaultGoogleOAuthTokenURL
	}
	return c
}

type Registry struct {
	meta   *MetaProvider
	google *GoogleAdsProvider
}

func NewRegistry(cfg Config, client *http.Client) *Registry {
	cfg = cfg.WithDefaults()
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	return &Registry{
		meta:   NewMetaProvider(MetaConfigFromConfig(cfg), client),
		google: NewGoogleAdsProvider(GoogleAdsConfigFromConfig(cfg), client),
	}
}

func (r *Registry) Readiness() []ProviderStatus {
	if r == nil {
		return []ProviderStatus{
			notConfiguredStatus("meta_pages", []string{"META_PAGE_ID", "META_PAGE_ACCESS_TOKEN"}, "Facebook Page publishing is not configured."),
			notConfiguredStatus("meta_instagram", []string{"META_INSTAGRAM_BUSINESS_ACCOUNT_ID", "META_PAGE_ACCESS_TOKEN"}, "Instagram Business publishing is not configured."),
			notConfiguredStatus("meta_ads", []string{"META_AD_ACCOUNT_ID", "META_ADS_ACCESS_TOKEN"}, "Meta Ads buying/report sync is not configured."),
			notConfiguredStatus("google_ads", []string{"GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"}, "Google Ads is not configured."),
		}
	}
	out := make([]ProviderStatus, 0, 4)
	out = append(out, r.meta.PageReadiness(), r.meta.InstagramReadiness(), r.meta.AdsReadiness(), r.google.Readiness())
	return out
}

func (r *Registry) PublishSocial(ctx context.Context, req SocialPostRequest) (ProviderResult, error) {
	if r == nil || r.meta == nil {
		return ProviderResult{Provider: "meta_pages", Status: "requires_provider"}, ErrNotConfigured
	}
	return r.meta.PublishSocial(ctx, req)
}

func (r *Registry) ValidateGoogleAds(ctx context.Context) (ProviderResult, error) {
	if r == nil || r.google == nil {
		return ProviderResult{Provider: "google_ads", Status: "requires_provider"}, ErrNotConfigured
	}
	return r.google.ValidateCredentials(ctx)
}

func trim(v string) string {
	return strings.TrimSpace(v)
}
