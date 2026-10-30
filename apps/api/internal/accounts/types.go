// SPDX-License-Identifier: AGPL-3.0-only
//
// Package accounts implements the SUB-012 first-class B2B account /
// company object: a tenant-scoped, RLS-protected org record that many
// contacts point at via subscribers.account_id (the many-to-one link).
//
// The denormalised merge_fields.COMPANY pointer on subscribers is
// preserved for back-compat; account_id is the canonical join key.
package accounts

import "time"

// Account is one persisted org/company row.
type Account struct {
	ID        string         `json:"id"`
	TenantID  string         `json:"tenant_id"`
	Name      string         `json:"name"`
	Industry  string         `json:"industry"`
	Country   string         `json:"country"`
	Metadata  map[string]any `json:"metadata"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// CreateInput is the body of POST /api/v1/accounts.
type CreateInput struct {
	Name     string         `json:"name"`
	Industry string         `json:"industry"`
	Country  string         `json:"country"`
	Metadata map[string]any `json:"metadata"`
}

// UpdateInput is the body of PATCH /api/v1/accounts/{id}. Pointer fields
// distinguish "omitted" (leave untouched) from "explicit empty" (clear).
// Metadata is a non-pointer map: a non-nil map replaces the whole blob, a
// nil map leaves it untouched.
type UpdateInput struct {
	Name     *string        `json:"name"`
	Industry *string        `json:"industry"`
	Country  *string        `json:"country"`
	Metadata map[string]any `json:"metadata"`
}

// ListPage is the response envelope for GET /api/v1/accounts.
type ListPage struct {
	Items []Account `json:"items"`
	Total int       `json:"total"`
}

// MaxNameLength caps the display name. Names surface in pickers + URLs,
// so unbounded names are a footgun.
const MaxNameLength = 200

// MaxIndustryLength / MaxCountryLength cap the two promoted scalar
// columns so a runaway client value can't bloat the row.
const (
	MaxIndustryLength = 120
	MaxCountryLength  = 8
)
