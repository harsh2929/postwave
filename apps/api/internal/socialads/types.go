package socialads

import "errors"

var ErrNotConfigured = errors.New("social/ads provider is not configured")

type ProviderStatus struct {
	Provider string   `json:"provider"`
	Status   string   `json:"status"`
	Detail   string   `json:"detail"`
	Missing  []string `json:"missing,omitempty"`
	Docs     []string `json:"docs,omitempty"`
	Version  string   `json:"version,omitempty"`
}

type ProviderResult struct {
	Provider   string
	Status     string
	ProviderID string
	Message    string
	Raw        map[string]any
}

type SocialPostRequest struct {
	Network   string
	AccountID string
	Text      string
	LinkURL   string
	MediaURLs []string
}

func notConfiguredStatus(provider string, missing []string, detail string) ProviderStatus {
	return ProviderStatus{
		Provider: provider,
		Status:   "missing_credentials",
		Detail:   detail,
		Missing:  append([]string(nil), missing...),
	}
}

func configuredStatus(provider, detail, version string, docs []string) ProviderStatus {
	return ProviderStatus{
		Provider: provider,
		Status:   "configured",
		Detail:   detail,
		Version:  version,
		Docs:     append([]string(nil), docs...),
	}
}
