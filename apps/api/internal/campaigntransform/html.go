// SPDX-License-Identifier: AGPL-3.0-only

// Package campaigntransform owns deterministic post-projection transforms
// shared by assurance artifacts and live campaign delivery. A transform must
// live here before the canonical compiler can certify it; transports may not
// mutate the returned HTML.
package campaigntransform

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	stdhtml "html"
	"io"
	"net/url"
	"sort"
	"strings"

	xhtml "golang.org/x/net/html"
)

const Version = "postwave.campaign-transform.html.v1"

var ErrInvalidTrackingSettings = errors.New("campaign transform: invalid tracking settings")

type Result struct {
	HTML    string  `json:"html"`
	Receipt Receipt `json:"receipt"`
}

// Receipt is persisted in the compiler receipt. UTMParameters are the exact
// normalized values applied to eligible absolute HTTP(S) anchor URLs.
type Receipt struct {
	Version          string            `json:"version"`
	PreviewInserted  bool              `json:"preview_inserted"`
	PreviewTextHash  string            `json:"preview_text_hash,omitempty"`
	UTMParameters    map[string]string `json:"utm_parameters"`
	OutputHTMLSHA256 string            `json:"output_html_sha256"`
}

// ApplyHTML is the strict canonical transform path. Malformed or wrongly
// typed tracking settings are rejected so assurance cannot certify an input
// that live delivery interprets differently.
func ApplyHTML(body, previewText string, trackingSettings json.RawMessage) (Result, error) {
	parameters, err := decodeUTMParameters(trackingSettings, true)
	if err != nil {
		return Result{}, err
	}
	return apply(body, previewText, parameters), nil
}

// ApplyHTMLLegacy preserves the historical send-loop behavior while that path
// is shadowed: malformed tracking JSON simply disables UTM rewriting, but the
// compiler-owned preheader is still inserted. New assurance artifacts must use
// ApplyHTML and may never use this compatibility function.
func ApplyHTMLLegacy(body, previewText string, trackingSettings json.RawMessage) Result {
	parameters, _ := decodeUTMParameters(trackingSettings, false)
	return apply(body, previewText, parameters)
}

func apply(body, previewText string, parameters map[string]string) Result {
	previewText = strings.TrimSpace(previewText)
	transformed := InsertPreviewText(body, previewText)
	if len(parameters) > 0 {
		transformed = AppendUTMParameters(transformed, parameters)
	}
	receipt := Receipt{
		Version:          Version,
		PreviewInserted:  previewText != "",
		UTMParameters:    cloneStringMap(parameters),
		OutputHTMLSHA256: digest(transformed),
	}
	if previewText != "" {
		receipt.PreviewTextHash = digest(previewText)
	}
	return Result{HTML: transformed, Receipt: receipt}
}

func decodeUTMParameters(raw json.RawMessage, strict bool) (map[string]string, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return map[string]string{}, nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var settings map[string]any
	if err := decoder.Decode(&settings); err != nil {
		if strict {
			return nil, fmt.Errorf("%w: malformed JSON", ErrInvalidTrackingSettings)
		}
		return map[string]string{}, nil
	}
	if settings == nil {
		if strict {
			return nil, fmt.Errorf("%w: expected a JSON object", ErrInvalidTrackingSettings)
		}
		return map[string]string{}, nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		if strict {
			return nil, fmt.Errorf("%w: trailing JSON value", ErrInvalidTrackingSettings)
		}
		return map[string]string{}, nil
	} else if !errors.Is(err, io.EOF) {
		if strict {
			return nil, fmt.Errorf("%w: trailing malformed JSON", ErrInvalidTrackingSettings)
		}
		return map[string]string{}, nil
	}
	enabledValue, configured := settings["google_analytics"]
	if !configured {
		return map[string]string{}, nil
	}
	enabled, ok := enabledValue.(bool)
	if !ok {
		if strict {
			return nil, fmt.Errorf("%w: google_analytics must be boolean", ErrInvalidTrackingSettings)
		}
		return map[string]string{}, nil
	}
	if !enabled {
		return map[string]string{}, nil
	}
	parameters := make(map[string]string, 3)
	for _, key := range []string{"utm_source", "utm_medium", "utm_campaign"} {
		value, exists := settings[key]
		if !exists {
			continue
		}
		text, ok := value.(string)
		if !ok {
			if strict {
				return nil, fmt.Errorf("%w: %s must be a string", ErrInvalidTrackingSettings, key)
			}
			continue
		}
		if text = strings.TrimSpace(text); text != "" {
			parameters[key] = text
		}
	}
	return parameters, nil
}

// InsertPreviewText inserts the compiler-owned, escaped preheader immediately
// after an HTML body start tag, or before a fragment when no body exists.
func InsertPreviewText(body, previewText string) string {
	previewText = strings.TrimSpace(previewText)
	if previewText == "" {
		return body
	}
	preheader := `<div data-postwave-preheader style="display:none!important;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">` + stdhtml.EscapeString(previewText) + `</div>`
	lower := strings.ToLower(body)
	if bodyIndex := strings.Index(lower, "<body"); bodyIndex >= 0 {
		if closeIndex := strings.Index(body[bodyIndex:], ">"); closeIndex >= 0 {
			insertAt := bodyIndex + closeIndex + 1
			return body[:insertAt] + preheader + body[insertAt:]
		}
	}
	return preheader + body
}

// AppendUTMParameters rewrites only absolute HTTP(S) anchor destinations.
// Template links, mailto links, fragments, image sources, and unsubscribe
// placeholders remain untouched.
func AppendUTMParameters(body string, parameters map[string]string) string {
	if len(parameters) == 0 || body == "" {
		return body
	}
	keys := make([]string, 0, len(parameters))
	for key := range parameters {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	tokenizer := xhtml.NewTokenizer(strings.NewReader(body))
	var out strings.Builder
	out.Grow(len(body) + 64)
	for {
		tokenType := tokenizer.Next()
		if tokenType == xhtml.ErrorToken {
			return out.String()
		}
		if tokenType != xhtml.StartTagToken && tokenType != xhtml.SelfClosingTagToken {
			out.Write(tokenizer.Raw())
			continue
		}
		token := tokenizer.Token()
		if !strings.EqualFold(token.Data, "a") {
			out.Write(tokenizer.Raw())
			continue
		}
		changed := false
		for index := range token.Attr {
			if !strings.EqualFold(token.Attr[index].Key, "href") {
				continue
			}
			parsed, err := url.Parse(token.Attr[index].Val)
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
				continue
			}
			query := parsed.Query()
			for _, key := range keys {
				query.Set(key, parameters[key])
			}
			parsed.RawQuery = query.Encode()
			token.Attr[index].Val = parsed.String()
			changed = true
		}
		if changed {
			out.WriteString(token.String())
		} else {
			out.Write(tokenizer.Raw())
		}
	}
}

func cloneStringMap(input map[string]string) map[string]string {
	out := make(map[string]string, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
