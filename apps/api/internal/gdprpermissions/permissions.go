// SPDX-License-Identifier: AGPL-3.0-only

// Package gdprpermissions owns the canonical subscriber GDPR-permission JSON
// shape and merge semantics. The database and Mailchimp-compatible API store
// permissions as an array of objects, not as one object keyed by category.
package gdprpermissions

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Decode reads the canonical array shape. It also accepts the legacy object
// shape emitted by older merge code and converts it to canonical permission
// entries so those rows remain readable and are repaired on their next write.
func Decode(raw []byte) ([]map[string]any, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return []map[string]any{}, nil
	}

	var list []map[string]any
	if err := json.Unmarshal(trimmed, &list); err == nil {
		if list == nil {
			return []map[string]any{}, nil
		}
		return list, nil
	}

	var legacy map[string]any
	if err := json.Unmarshal(trimmed, &legacy); err != nil {
		return nil, fmt.Errorf("permissions must be a JSON array of objects: %w", err)
	}
	if len(legacy) == 0 {
		return []map[string]any{}, nil
	}
	if looksLikePermission(legacy) {
		return []map[string]any{clone(legacy)}, nil
	}

	keys := make([]string, 0, len(legacy))
	for key := range legacy {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]map[string]any, 0, len(keys))
	for _, key := range keys {
		value := legacy[key]
		if fields, ok := value.(map[string]any); ok {
			entry := clone(fields)
			if permissionID(entry) == "" {
				entry["marketing_permission_id"] = key
			}
			out = append(out, entry)
			continue
		}
		out = append(out, map[string]any{
			"marketing_permission_id": key,
			"enabled":                 value,
		})
	}
	return out, nil
}

// MergeRestrictive unions two permission lists. Entries are matched by
// audience plus Mailchimp permission identity; primary fields win except that
// an explicit false boolean on either side wins, preventing a merge from
// restoring consent that either source denied.
func MergeRestrictive(primary, duplicate []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(primary)+len(duplicate))
	index := make(map[string]int, len(primary)+len(duplicate))
	for _, permission := range primary {
		entry := clone(permission)
		key := identity(entry)
		if existing, ok := index[key]; ok {
			out[existing] = mergeEntry(out[existing], entry)
			continue
		}
		index[key] = len(out)
		out = append(out, entry)
	}
	for _, permission := range duplicate {
		entry := clone(permission)
		key := identity(entry)
		if existing, ok := index[key]; ok {
			out[existing] = mergeEntry(out[existing], entry)
			continue
		}
		index[key] = len(out)
		out = append(out, entry)
	}
	return out
}

func mergeEntry(primary, duplicate map[string]any) map[string]any {
	out := clone(primary)
	for key, duplicateValue := range duplicate {
		primaryValue, exists := out[key]
		if !exists {
			out[key] = duplicateValue
			continue
		}
		primaryBool, primaryIsBool := primaryValue.(bool)
		duplicateBool, duplicateIsBool := duplicateValue.(bool)
		if primaryIsBool && duplicateIsBool && (!primaryBool || !duplicateBool) {
			out[key] = false
		}
	}
	return out
}

func identity(permission map[string]any) string {
	audience := scalarString(permission["audience_id"])
	if id := permissionID(permission); id != "" {
		return audience + "\x00" + id
	}
	raw, _ := json.Marshal(permission) // map keys are encoded deterministically.
	return audience + "\x00" + string(raw)
}

func permissionID(permission map[string]any) string {
	for _, key := range []string{"marketing_permission_id", "id", "text"} {
		if value := scalarString(permission[key]); value != "" {
			return value
		}
	}
	return ""
}

func scalarString(value any) string {
	switch value := value.(type) {
	case string:
		return strings.TrimSpace(value)
	case json.Number:
		return value.String()
	case float64:
		return fmt.Sprintf("%g", value)
	default:
		return ""
	}
}

func looksLikePermission(value map[string]any) bool {
	for _, key := range []string{"marketing_permission_id", "id", "text", "enabled", "audience_id"} {
		if _, ok := value[key]; ok {
			return true
		}
	}
	return false
}

func clone(value map[string]any) map[string]any {
	out := make(map[string]any, len(value))
	for key, item := range value {
		out[key] = item
	}
	return out
}
