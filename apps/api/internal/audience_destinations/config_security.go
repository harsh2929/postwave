// SPDX-License-Identifier: AGPL-3.0-only
package audience_destinations

import (
	"encoding/json"
	"strings"
)

func rawAudienceCredentialConfigKey(cfg map[string]any) string {
	return findAudienceConfigKey(cfg, "", func(key string) bool {
		switch key {
		case "access_token", "api_key", "api_secret", "client_secret", "developer_token",
			"password", "private_key", "refresh_token", "secret", "token":
			return true
		}
		return false
	})
}

func unsafeAudienceTransportConfigKey(cfg map[string]any) string {
	return findAudienceConfigKey(cfg, "", func(key string) bool {
		switch key {
		case "api_base", "base_url", "data_manager_api_base", "data_manager_base_url", "endpoint_url":
			return true
		}
		return false
	})
}

func findAudienceConfigKey(value any, prefix string, match func(string) bool) string {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			normalized := strings.ToLower(strings.TrimSpace(key))
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			if match(normalized) {
				return path
			}
			if found := findAudienceConfigKey(child, path, match); found != "" {
				return found
			}
		}
	case []any:
		for _, child := range typed {
			if found := findAudienceConfigKey(child, prefix, match); found != "" {
				return found
			}
		}
	}
	return ""
}

func maskedAudienceDestinationConfigJSON(text string) json.RawMessage {
	cfg := parseDestinationConfig(text)
	if len(cfg) == 0 {
		return json.RawMessage("{}")
	}
	masked := maskDestinationConfig(cfg)
	raw, err := json.Marshal(masked)
	if err != nil {
		return json.RawMessage("{}")
	}
	return raw
}

func stripAudienceProviderCleanup(cfg map[string]any) map[string]any {
	if cfg == nil {
		return map[string]any{}
	}
	delete(cfg, "provider_cleanup")
	return cfg
}

func marshalDestinationConfig(cfg map[string]any) json.RawMessage {
	if cfg == nil {
		return json.RawMessage("{}")
	}
	raw, err := json.Marshal(cfg)
	if err != nil {
		return json.RawMessage("{}")
	}
	return raw
}

func enrichAudienceDestinationConfig(provider string, cfg map[string]any, externalAudienceID string) map[string]any {
	if cfg == nil {
		cfg = map[string]any{}
	}
	externalAudienceID = strings.TrimSpace(externalAudienceID)
	if externalAudienceID == "" {
		return cfg
	}
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case string(ProviderMeta), string(ProviderTikTok):
		if configString(cfg, "audience_id") == "" {
			cfg["audience_id"] = externalAudienceID
		}
	case string(ProviderGoogleAds):
		if configString(cfg, "user_list_id") == "" {
			cfg["user_list_id"] = externalAudienceID
		}
	case string(ProviderLinkedIn), string(ProviderSnap):
		if configString(cfg, "segment_id") == "" {
			cfg["segment_id"] = externalAudienceID
		}
	}
	return cfg
}
