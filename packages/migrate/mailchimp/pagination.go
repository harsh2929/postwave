// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
)

const mailchimpMaxPageSize = 1000

const mailchimpPageCursorPrefix = "mc1."

type mailchimpPageCursor struct {
	Version          int    `json:"v"`
	Resource         string `json:"resource"`
	Scope            string `json:"scope,omitempty"`
	Offset           int    `json:"offset"`
	PreviousPageHash string `json:"previous_page_hash,omitempty"`
}

func encodeMailchimpPageCursor(resource, scope string, offset int, previousPage interface{}) string {
	cursor := mailchimpPageCursor{
		Version:  1,
		Resource: resource,
		Scope:    scope,
		Offset:   offset,
	}
	if previousPage != nil {
		cursor.PreviousPageHash = stablePageSignature(previousPage)
	}
	raw, _ := json.Marshal(cursor)
	return mailchimpPageCursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
}

func decodeMailchimpPageCursor(raw, resource string) (mailchimpPageCursor, bool, error) {
	if !strings.HasPrefix(raw, mailchimpPageCursorPrefix) {
		return mailchimpPageCursor{}, false, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, mailchimpPageCursorPrefix))
	if err != nil {
		return mailchimpPageCursor{}, true, fmt.Errorf("mailchimp: bad %s cursor %q", resource, raw)
	}
	var cursor mailchimpPageCursor
	if err := json.Unmarshal(payload, &cursor); err != nil || cursor.Version != 1 || cursor.Resource != resource || cursor.Offset < 0 {
		return mailchimpPageCursor{}, true, fmt.Errorf("mailchimp: bad %s cursor %q", resource, raw)
	}
	return cursor, true, nil
}

func validatePageCursor(resource string, cursor mailchimpPageCursor, page interface{}) error {
	if cursor.PreviousPageHash == "" {
		return nil
	}
	if stablePageSignature(page) == cursor.PreviousPageHash {
		return fmt.Errorf("mailchimp: %s pagination stalled at offset %d (provider repeated the previous page)", resource, cursor.Offset)
	}
	return nil
}

func stablePageSignature(page interface{}) string {
	raw, _ := json.Marshal(page)
	sum := sha256.Sum256(raw)
	return fmt.Sprintf("%x", sum[:])
}

// paginationFinished validates Mailchimp's total_items contract as well as
// deciding whether another offset page is required. A short or empty page
// before total_items has been reached is treated as source truncation rather
// than silently accepting incomplete data.
func paginationFinished(resource string, offset, pageLen, totalItems, pageSize int) (bool, error) {
	if pageLen < 0 || pageLen > pageSize {
		return false, fmt.Errorf("mailchimp: %s returned invalid page length %d (count=%d)", resource, pageLen, pageSize)
	}
	if totalItems > 0 {
		if offset+pageLen >= totalItems {
			return true, nil
		}
		if pageLen == 0 {
			return false, fmt.Errorf("mailchimp: %s pagination truncated at offset %d: total_items=%d but the page was empty", resource, offset, totalItems)
		}
		if pageLen < pageSize {
			return false, fmt.Errorf("mailchimp: %s pagination truncated at offset %d: got %d of %d remaining items", resource, offset, pageLen, totalItems-offset)
		}
		return false, nil
	}
	return pageLen < pageSize, nil
}

func ensurePaginationAdvanced(resource string, offset, pageLen, pageSize int, page interface{}, previousSignature *string) error {
	if previousSignature == nil {
		return nil
	}
	signature := stablePageSignature(page)
	if offset > 0 && pageLen == pageSize && signature == *previousSignature {
		return fmt.Errorf("mailchimp: %s pagination stalled at offset %d (provider repeated the previous full page)", resource, offset)
	}
	*previousSignature = signature
	return nil
}

// fetchAllMapCollection collects an endpoint whose response is intentionally
// retained as arbitrary JSON (reports and source-archive resources). The
// returned map has the first page's metadata and a fully aggregated collection
// under whichever candidate key Mailchimp returned.
func (a *Adapter) fetchAllMapCollection(
	ctx context.Context,
	sess adapter.Session,
	resource string,
	pathForOffset func(offset int) string,
	collectionKeys ...string,
) (map[string]interface{}, error) {
	var out map[string]interface{}
	var all []interface{}
	collectionKey := ""
	lastSignature := ""

	for offset := 0; ; offset += mailchimpMaxPageSize {
		var page map[string]interface{}
		if err := a.do(ctx, sess, http.MethodGet, pathForOffset(offset), nil, &page); err != nil {
			return nil, fmt.Errorf("mailchimp: fetch %s page at offset %d: %w", resource, offset, err)
		}
		if out == nil {
			out = cloneAnyMap(page)
		}
		key, items, found := findCollection(page, collectionKeys...)
		if !found {
			total := totalItemsFromMap(page)
			if total > 0 {
				return nil, fmt.Errorf("mailchimp: %s reported total_items=%d without a supported collection field", resource, total)
			}
			// A few endpoints legitimately return an empty object with no array.
			return out, nil
		}
		if collectionKey == "" {
			collectionKey = key
		} else if key != collectionKey {
			return nil, fmt.Errorf("mailchimp: %s changed collection field from %q to %q while paginating", resource, collectionKey, key)
		}

		signatureRaw, _ := json.Marshal(items)
		signature := string(signatureRaw)
		if offset > 0 && len(items) == mailchimpMaxPageSize && signature == lastSignature {
			return nil, fmt.Errorf("mailchimp: %s pagination stalled at offset %d (provider repeated the previous full page)", resource, offset)
		}
		lastSignature = signature
		all = append(all, items...)

		done, err := paginationFinished(resource, offset, len(items), totalItemsFromMap(page), mailchimpMaxPageSize)
		if err != nil {
			return nil, err
		}
		if done {
			out[collectionKey] = all
			out["total_items"] = len(all)
			return out, nil
		}
	}
}

func findCollection(page map[string]interface{}, keys ...string) (string, []interface{}, bool) {
	for _, key := range keys {
		value, exists := page[key]
		if !exists {
			continue
		}
		items, ok := value.([]interface{})
		if !ok {
			return key, nil, false
		}
		return key, items, true
	}
	return "", nil, false
}

func totalItemsFromMap(page map[string]interface{}) int {
	switch value := page["total_items"].(type) {
	case float64:
		return int(value)
	case int:
		return value
	case json.Number:
		n, _ := value.Int64()
		return int(n)
	default:
		return 0
	}
}
