package adapter

import (
	"fmt"
	"net/url"
	"strings"
)

// BuildURL joins an adapter API base and endpoint path without allowing
// absolute-path surprises, credentials in base URLs, fragments, or path
// traversal. Query strings in path are preserved because several upstream APIs
// expect adapter-specific pagination/auth query parameters.
func BuildURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(baseRaw, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid base URL")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported base URL scheme")
	}

	rel := strings.TrimLeft(path, "/")
	if strings.Contains(rel, "#") {
		return "", fmt.Errorf("unsafe request path")
	}
	pathPart, rawQuery, _ := strings.Cut(rel, "?")
	for _, segment := range strings.Split(pathPart, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") {
			return "", fmt.Errorf("unsafe request path")
		}
	}
	// pathPart may already contain an escaped path segment supplied by a
	// provider adapter (for example a HubSpot subscriber email containing
	// "/"). Assigning that escaped text directly to URL.Path would escape the
	// percent sign a second time. Keep the decoded path and its validated raw
	// representation together so URL.String emits each escape exactly once.
	rawPath := strings.TrimRight(base.EscapedPath(), "/") + "/" + pathPart
	decodedPath, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", fmt.Errorf("unsafe request path")
	}
	base.Path = decodedPath
	base.RawPath = rawPath
	base.RawQuery = rawQuery
	return base.String(), nil
}
