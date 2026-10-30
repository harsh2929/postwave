package handlers

import (
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/postwave/migrate/canonical"
)

func (h *Migration) oauthReady(source canonical.SourcePlatform) (bool, string) {
	if ok, message := oauthConfigured(source); !ok {
		return ok, message
	}
	if source != canonical.SourceMailchimp && source != canonical.SourceConvertKit {
		return true, ""
	}
	raw := strings.TrimSpace(h.redirectURI(source))
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Path == "" {
		return false, "Migration OAuth callback URL is not configured"
	}
	if u.Scheme == "https" {
		return true, ""
	}
	env := strings.ToLower(strings.TrimSpace(firstNonEmpty(os.Getenv("POSTWAVE_ENV"), os.Getenv("ENVIRONMENT"), os.Getenv("NODE_ENV"))))
	local := env == "" || env == "development" || env == "dev" || env == "test" || env == "local"
	host := strings.ToLower(u.Hostname())
	ip := net.ParseIP(host)
	if local && u.Scheme == "http" && (host == "localhost" || (ip != nil && ip.IsLoopback())) {
		return true, ""
	}
	return false, "Migration OAuth callback must use HTTPS outside local development"
}
