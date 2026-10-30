// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

// PostgresRecipientResolver resolves the small, declared slot set directly
// from the tenant's canonical subscriber row. It accepts only scalar values;
// nested objects/arrays and ambiguous custom/merge-field duplicates fail
// closed rather than being stringified differently across runtimes.
type PostgresRecipientResolver struct{ Pool *db.Pool }

var _ RecipientResolver = (*PostgresRecipientResolver)(nil)

func (r *PostgresRecipientResolver) ResolveRecipient(ctx context.Context, input RecipientResolveInput) (RecipientValues, error) {
	if r == nil || r.Pool == nil {
		return RecipientValues{}, errors.New("recipient resolver pool is required")
	}
	if _, err := uuid.Parse(input.TenantID); err != nil {
		return RecipientValues{}, errors.New("invalid tenant id")
	}
	if _, err := uuid.Parse(input.CampaignID); err != nil {
		return RecipientValues{}, errors.New("invalid campaign id")
	}
	if strings.TrimSpace(input.Recipient) == "" || len(input.RequestedSlots) > 256 {
		return RecipientValues{}, fmt.Errorf("%w: invalid recipient or slot count", ErrRecipientValuesUnsupported)
	}
	tx, err := db.WithTenant(ctx, r.Pool, input.TenantID)
	if err != nil {
		return RecipientValues{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		firstName, lastName, fullName, displayName        string
		locale, languageCode, country, region, externalID pgtype.Text
		customRaw, mergeRaw                               []byte
	)
	err = tx.QueryRow(ctx, `
SELECT first_name, last_name, full_name, display_name,
       locale, language, country, region, external_id,
       COALESCE(custom_fields, '{}'::jsonb), COALESCE(merge_fields, '{}'::jsonb)
  FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
 LIMIT 1`, input.TenantID, strings.TrimSpace(input.Recipient)).Scan(
		&firstName, &lastName, &fullName, &displayName,
		&locale, &languageCode, &country, &region, &externalID,
		&customRaw, &mergeRaw,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecipientValues{}, fmt.Errorf("%w: recipient has no canonical subscriber row", ErrRecipientValuesUnsupported)
	}
	if err != nil {
		return RecipientValues{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RecipientValues{}, err
	}

	standard := map[string]string{
		"email": strings.TrimSpace(input.Recipient), "first_name": firstName,
		"last_name": lastName, "full_name": fullName, "display_name": displayName,
	}
	putNullableText(standard, "locale", locale)
	putNullableText(standard, "language", languageCode)
	putNullableText(standard, "country", country)
	putNullableText(standard, "region", region)
	putNullableText(standard, "external_id", externalID)
	custom, err := decodeScalarObject(customRaw)
	if err != nil {
		return RecipientValues{}, fmt.Errorf("%w: custom fields: %v", ErrRecipientValuesUnsupported, err)
	}
	merge, err := decodeScalarObject(mergeRaw)
	if err != nil {
		return RecipientValues{}, fmt.Errorf("%w: merge fields: %v", ErrRecipientValuesUnsupported, err)
	}
	requested := make(map[string]semanticemail.SlotID, len(input.RequestedSlots))
	for _, slot := range input.RequestedSlots {
		name := strings.TrimSpace(string(slot))
		if name == "" || strings.HasPrefix(name, "_") {
			return RecipientValues{}, fmt.Errorf("%w: unsafe declared slot %q", ErrRecipientValuesUnsupported, slot)
		}
		if _, duplicate := requested[name]; duplicate {
			return RecipientValues{}, fmt.Errorf("%w: duplicate declared slot %q", ErrRecipientValuesUnsupported, slot)
		}
		requested[name] = slot
	}
	values := RecipientValues{Slots: make(map[semanticemail.SlotID]string, len(requested))}
	if locale.Valid {
		values.Locale = strings.TrimSpace(locale.String)
	}
	for name, slot := range requested {
		candidates := make([]string, 0, 3)
		if value, ok := standard[name]; ok {
			candidates = append(candidates, value)
		}
		if value, ok := custom[name]; ok {
			candidates = append(candidates, value)
		}
		if value, ok := merge[name]; ok {
			candidates = append(candidates, value)
		}
		if len(candidates) == 0 {
			continue
		}
		value := candidates[0]
		for _, candidate := range candidates[1:] {
			if candidate != value {
				return RecipientValues{}, fmt.Errorf("%w: slot %q has ambiguous subscriber sources", ErrRecipientValuesUnsupported, name)
			}
		}
		values.Slots[slot] = value
	}
	return values, nil
}

func putNullableText(target map[string]string, key string, value pgtype.Text) {
	if value.Valid {
		target[key] = value.String
	}
}

func decodeScalarObject(raw []byte) (map[string]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil {
		return nil, err
	}
	if object == nil {
		return nil, errors.New("JSON object required")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON")
	}
	out := make(map[string]string, len(object))
	for key, rawValue := range object {
		if strings.HasPrefix(key, "_") {
			continue
		}
		switch value := rawValue.(type) {
		case nil:
			continue
		case string:
			out[key] = value
		case json.Number:
			out[key] = value.String()
		case bool:
			out[key] = strconv.FormatBool(value)
		default:
			// Ignore undeclared complex profile metadata. If the campaign asks
			// for this exact key below, it remains missing and compilation will
			// apply an authored fallback or fail closed.
			continue
		}
	}
	return out, nil
}
