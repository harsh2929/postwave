// SPDX-License-Identifier: AGPL-3.0-only

package observability

import (
	"net/url"
	"regexp"
	"strings"
)

const publicPreferenceCapabilityPrefix = "/api/public/preferences/"
const publicSupportIntegrationPrefix = "/api/public/support-integrations/"

var publicSupportProviderFamilies = map[string]struct{}{
	"ada": {}, "asana-support": {}, "clickup-support": {}, "crisp": {},
	"drift": {}, "freshchat": {}, "freshdesk": {}, "front": {},
	"gladly": {}, "gorgias": {}, "groove": {}, "help-scout": {},
	"helpcrunch": {}, "hubspot-service-hub": {}, "intercom": {},
	"jira-service-management": {}, "kayako": {}, "kustomer": {},
	"linear": {}, "livechat": {}, "olark": {}, "reamaze": {},
	"salesforce-service-cloud": {}, "tidio": {}, "zendesk": {},
	"zoho-desk": {},
}

var (
	emailPathSegmentRE  = regexp.MustCompile(`[^/@\s]+@[^/@\s]+\.[^/@\s]+`)
	secretPathSegmentRE = regexp.MustCompile(`^[A-Za-z0-9._~+/=-]{24,}$`)
	hexPathSegmentRE    = regexp.MustCompile(`^[0-9a-fA-F]{32,}$`)
	uuidPathSegmentRE   = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	jwtPathSegmentRE    = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`)
	localePathSegmentRE = regexp.MustCompile(`^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$`)
)

// RedactSensitivePath replaces recipient-bound capabilities and other
// credential/PII-shaped path segments while preserving the surrounding route
// shape for operations. The public preference capability position is always
// scrubbed, even if a malformed or future token is too short for heuristics.
func RedactSensitivePath(path string) string {
	if IsPublicSupportIntegrationPath(path) {
		return redactPublicSupportIntegrationPath(path)
	}
	preferenceSafePath := path
	if !strings.HasPrefix(path, publicPreferenceCapabilityPrefix) {
		preferenceSafePath = path
	} else {
		remainder := strings.TrimPrefix(path, publicPreferenceCapabilityPrefix)
		if remainder != "" {
			capability := remainder
			if slash := strings.IndexByte(remainder, '/'); slash >= 0 {
				capability = remainder[:slash]
			}
			if capability != "" {
				preferenceSafePath = publicPreferenceCapabilityPrefix + "[redacted]" + remainder[len(capability):]
			}
		}
	}
	parts := strings.Split(preferenceSafePath, "/")
	touched := preferenceSafePath != path
	for i := 0; i+4 < len(parts); i++ {
		if parts[i] == "api" && parts[i+1] == "v1" && parts[i+2] == "sms" && parts[i+3] == "conversations" {
			candidate, err := url.PathUnescape(parts[i+4])
			if err != nil {
				candidate = parts[i+4]
			}
			if candidate != "" && candidate != "search" && candidate != "bulk" {
				parts[i+4] = "[redacted]"
				touched = true
				if i+6 < len(parts) && parts[i+5] == "tags" && parts[i+6] != "" {
					parts[i+6] = "[redacted]"
				}
			}
		}
	}
	for i, part := range parts {
		if part != "preferences" || i+1 >= len(parts) || parts[i+1] == "" {
			continue
		}
		if i == 1 || (i == 2 && localePathSegmentRE.MatchString(parts[1])) {
			parts[i+1] = "[redacted]"
			touched = true
		}
	}
	for i, part := range parts {
		if isSensitivePathSegment(part) {
			parts[i] = "[redacted]"
			touched = true
		}
	}
	if !touched {
		return path
	}
	return strings.Join(parts, "/")
}

// IsPublicSupportIntegrationPath reports whether the path is in the public
// support-provider ingress family. All descendants are treated as sensitive,
// including unmatched methods and future routes, because provider account IDs
// and URL bearer tokens otherwise become attacker-controlled telemetry labels.
func IsPublicSupportIntegrationPath(path string) bool {
	return strings.HasPrefix(path, publicSupportIntegrationPrefix)
}

func redactPublicSupportIntegrationPath(path string) string {
	remainder := strings.TrimPrefix(path, publicSupportIntegrationPrefix)
	parts := strings.Split(remainder, "/")
	for i, part := range parts {
		decoded, err := url.PathUnescape(part)
		if err != nil {
			decoded = part
		}
		switch {
		case decoded == "":
			// Preserve a trailing slash without creating a value-bearing label.
		case i == 0:
			if _, safe := publicSupportProviderFamilies[decoded]; !safe {
				parts[i] = "[redacted]"
			}
		case decoded == "webhooks" || decoded == "ingest":
			// These are static family markers, not provider/customer material.
		default:
			parts[i] = "[redacted]"
		}
	}
	return publicSupportIntegrationPrefix + strings.Join(parts, "/")
}

func isSensitivePathSegment(segment string) bool {
	if segment == "" || segment == "[redacted]" {
		return false
	}
	decoded, err := url.PathUnescape(segment)
	if err != nil {
		decoded = segment
	}
	return emailPathSegmentRE.MatchString(decoded) ||
		uuidPathSegmentRE.MatchString(decoded) ||
		jwtPathSegmentRE.MatchString(decoded) ||
		hexPathSegmentRE.MatchString(decoded) ||
		secretPathSegmentRE.MatchString(decoded)
}
