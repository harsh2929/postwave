// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import (
	"errors"
	"testing"
)

func validEnvironment() map[string]string {
	return map[string]string{
		FeatureEnvironmentKey:                         "true",
		"POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS":       "images.example.com,cdn.example.net",
		"POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET":     "/run/postwave/campaign-ocr.sock",
		"POSTWAVE_CAMPAIGN_IMAGE_OCR_ENGINE":          "tesseract",
		"POSTWAVE_CAMPAIGN_IMAGE_OCR_VERSION":         "tesseract.5.5.1-models.2026-08",
		"POSTWAVE_CAMPAIGN_IMAGE_SCANNER_UNIX_SOCKET": "/run/postwave/campaign-image-scanner.sock",
		"POSTWAVE_CAMPAIGN_IMAGE_SCANNER_ENGINE":      "clamav",
		"POSTWAVE_CAMPAIGN_IMAGE_SCANNER_VERSION":     "clamav.1.4.3-db.20260810",
		"POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_BUCKET":     "postwave-campaign-image-evidence",
		"POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_PREFIX":     "campaign-assurance/image-evidence/v1",
		"POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID": "arn:aws:kms:ap-south-1:123456789012:key/00000000-0000-4000-8000-000000000001",
		"POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_RETENTION":  "720h",
		"POSTWAVE_CAMPAIGN_IMAGE_OCR_CACHE_RETENTION": "336h",
		"POSTWAVE_CAMPAIGN_IMAGE_IPC_TIMEOUT":         "8s",
	}
}

func environmentReader(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestConfigurationFeatureOffAcquiresNoStagedCapability(t *testing.T) {
	configuration, err := ConfigurationFromEnvironment(environmentReader(map[string]string{
		FeatureEnvironmentKey:                         "false",
		"POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS":       "*.example.com",
		"POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET":     "tcp://untrusted.example",
		"POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID": "",
	}))
	if err != nil || configuration.Enabled || len(configuration.AllowedHosts) != 0 {
		t.Fatalf("feature-off configuration = %+v, err=%v", configuration, err)
	}
}

func TestConfigurationRequiresExactProductionIdentities(t *testing.T) {
	configuration, err := ConfigurationFromEnvironment(environmentReader(validEnvironment()))
	if err != nil {
		t.Fatal(err)
	}
	if !configuration.Enabled || len(configuration.AllowedHosts) != 2 ||
		configuration.OCR.SocketPath != "/run/postwave/campaign-ocr.sock" ||
		configuration.Broker.RequireContentScan != true ||
		configuration.Broker.EvidenceRetention != configuration.Evidence.Retention {
		t.Fatalf("unexpected exact configuration: %+v", configuration)
	}
}

func TestConfigurationRejectsWildcardHostNetworkEndpointAndLooseFlag(t *testing.T) {
	tests := []struct {
		name, key, value string
	}{
		{"wildcard", "POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS", "*.example.com"},
		{"host whitespace", "POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS", "images.example.com, cdn.example.net"},
		{"IP literal", "POSTWAVE_CAMPAIGN_IMAGE_ALLOWED_HOSTS", "203.0.113.4"},
		{"OCR TCP", "POSTWAVE_CAMPAIGN_IMAGE_OCR_UNIX_SOCKET", "tcp://127.0.0.1:9000"},
		{"relative scanner", "POSTWAVE_CAMPAIGN_IMAGE_SCANNER_UNIX_SOCKET", "run/scanner.sock"},
		{"loose flag", FeatureEnvironmentKey, "1"},
		{"bucket URL", "POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_BUCKET", "https://s3.example.com/bucket"},
		{"KMS alias", "POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_KMS_KEY_ID", "alias/campaign-images"},
		{"prefix traversal", "POSTWAVE_CAMPAIGN_IMAGE_EVIDENCE_PREFIX", "../campaign-images"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			values := validEnvironment()
			values[test.key] = test.value
			_, err := ConfigurationFromEnvironment(environmentReader(values))
			if !errors.Is(err, ErrInvalidConfiguration) {
				t.Fatalf("error = %v, want ErrInvalidConfiguration", err)
			}
		})
	}
}
