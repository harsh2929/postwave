package sms

import (
	"fmt"
	"net/url"
	"strings"
)

func providerURL(baseRaw, path string) (string, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseRaw), "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid provider base URL")
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return "", fmt.Errorf("unsupported provider base URL scheme")
	}
	if base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("unsafe provider base URL")
	}

	cleanPath := strings.TrimLeft(path, "/")
	pathPart, rawQuery, _ := strings.Cut(cleanPath, "?")
	for _, segment := range strings.Split(pathPart, "/") {
		unescaped, err := url.PathUnescape(segment)
		if err != nil {
			return "", fmt.Errorf("unsafe provider request path")
		}
		if segment == "." || segment == ".." || unescaped == "." || unescaped == ".." || strings.Contains(segment, "\\") || strings.Contains(unescaped, "\\") {
			return "", fmt.Errorf("unsafe provider request path")
		}
	}

	base.Path = strings.TrimRight(base.Path, "/") + "/" + pathPart
	base.RawQuery = rawQuery
	return base.String(), nil
}
