// SPDX-License-Identifier: MIT

package mailerlite

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

var sourceArchivePhases = []struct {
	path         string
	resourceType string
	label        string
	filterStatus string
}{
	{path: "/fields", resourceType: "mailerlite_custom_field", label: "custom field"},
	{path: "/campaigns", resourceType: "mailerlite_campaign_rebuild", label: "draft campaign", filterStatus: "draft"},
	{path: "/campaigns", resourceType: "mailerlite_campaign_rebuild", label: "ready campaign", filterStatus: "ready"},
	{path: "/forms/popup", resourceType: "mailerlite_form", label: "popup form"},
	{path: "/forms/embedded", resourceType: "mailerlite_form", label: "embedded form"},
	{path: "/forms/promotion", resourceType: "mailerlite_form", label: "promotion form"},
	{path: "/ecommerce/shops", resourceType: "mailerlite_ecommerce_shop", label: "ecommerce shop"},
}

type sourceArchiveCursor struct {
	Phase int `json:"phase"`
	Page  int `json:"page"`
}

func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	state, err := decodeSourceArchiveCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	if state.Phase >= len(sourceArchivePhases) {
		if state.Phase == len(sourceArchivePhases) {
			return []canonical.SourceArchiveItem{
				parityGap("mailerlite:sites_landing_pages", "sites_landing_pages", "Sites and landing pages", "MailerLite does not expose sites or landing pages through the documented Connect API. Inventory and rebuild/retirement evidence must be attached manually."),
			}, "", nil
		}
		return nil, "", fmt.Errorf("mailerlite: invalid source-archive phase %d", state.Phase)
	}

	phase := sourceArchivePhases[state.Phase]
	values := url.Values{
		"limit": {strconv.Itoa(listPageSize)},
		"page":  {strconv.Itoa(state.Page)},
	}
	if phase.filterStatus != "" {
		values.Set("filter[status]", phase.filterStatus)
	}
	path := withQuery(phase.path, values)
	var response struct {
		Data []json.RawMessage `json:"data"`
		Meta paginationMeta    `json:"meta"`
	}
	if err := a.do(ctx, sess, http.MethodGet, path, nil, &response); err != nil {
		return nil, "", err
	}

	items := make([]canonical.SourceArchiveItem, 0, len(response.Data))
	for _, raw := range response.Data {
		item, err := sourceArchiveItem(raw, phase.resourceType, phase.label)
		if err != nil {
			return nil, "", err
		}
		items = append(items, item)
	}

	next := sourceArchiveCursor{Phase: state.Phase + 1, Page: 1}
	if hasNextPage(state.Page, response.Meta, len(response.Data)) {
		next = sourceArchiveCursor{Phase: state.Phase, Page: state.Page + 1}
	}
	encoded, err := encodeSourceArchiveCursor(next)
	if err != nil {
		return nil, "", err
	}
	return items, encoded, nil
}

func sourceArchiveItem(raw json.RawMessage, resourceType, label string) (canonical.SourceArchiveItem, error) {
	var payload map[string]interface{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return canonical.SourceArchiveItem{}, fmt.Errorf("mailerlite: decode %s source archive: %w", label, err)
	}
	id := strings.TrimSpace(fmt.Sprint(payload["id"]))
	if id == "" || id == "<nil>" {
		return canonical.SourceArchiveItem{}, fmt.Errorf("mailerlite: %s source archive record has no id", label)
	}
	name := strings.TrimSpace(fmt.Sprint(payload["name"]))
	if name == "" || name == "<nil>" {
		name = "MailerLite " + label + " " + id
	}
	warning := "Preserved as source evidence; rebuild and test this resource in Moosewave before retiring it in MailerLite."
	switch resourceType {
	case "mailerlite_custom_field":
		warning = "Custom-field definition metadata is preserved, including fields with no subscriber value; destination values are materialized from the final subscriber snapshot."
	case "mailerlite_campaign_rebuild":
		warning = "Draft/ready campaign metadata is preserved for explicit recreation; verify content, audience filters, scheduling, and sender settings before activation."
	case "mailerlite_ecommerce_shop":
		warning = "Shop metadata is preserved as source evidence; reconnect catalog, customer, purchase, and attribution flows through Moosewave commerce integrations."
	}
	return canonical.SourceArchiveItem{
		SourceID:       "mailerlite:" + strings.ReplaceAll(label, " ", "_") + ":" + id,
		ResourceType:   resourceType,
		Name:           name,
		Status:         "manual_review",
		Payload:        payload,
		Warnings:       []string{warning},
		SourcePlatform: canonical.SourceMailerLite,
	}, nil
}

func decodeSourceArchiveCursor(cursor string) (sourceArchiveCursor, error) {
	if cursor == "" {
		return sourceArchiveCursor{Page: 1}, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return sourceArchiveCursor{}, fmt.Errorf("mailerlite: invalid source-archive cursor: %w", err)
	}
	var state sourceArchiveCursor
	if err := json.Unmarshal(raw, &state); err != nil {
		return sourceArchiveCursor{}, fmt.Errorf("mailerlite: invalid source-archive cursor: %w", err)
	}
	if state.Phase < 0 || state.Phase > len(sourceArchivePhases) || state.Page < 1 || state.Page > maxPageTraversal {
		return sourceArchiveCursor{}, fmt.Errorf("mailerlite: invalid source-archive cursor state")
	}
	return state, nil
}

func encodeSourceArchiveCursor(state sourceArchiveCursor) (string, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return "", fmt.Errorf("mailerlite: encode source-archive cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func parityGap(id, resourceType, name, detail string) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   "parity_gap:" + resourceType,
		Name:           name,
		Status:         "manual_review",
		Payload:        map[string]interface{}{"detail": detail},
		SourcePlatform: canonical.SourceMailerLite,
	}
}
