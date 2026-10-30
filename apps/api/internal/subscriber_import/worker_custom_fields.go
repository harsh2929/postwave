// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/customfields"
)

// validateChunkCustomFields applies the import's custom-field policy to a
// prepared chunk: the same read-only coercion the preflight ran. Auto creation
// has already completed fail-closed in processJob, so an unknown key or a
// type/catalog drift becomes a row failure rather than a raw JSON write. Under
// ModeOff the values pass through as the raw strings buildRowFields produced.
func (w *Worker) validateChunkCustomFields(ctx context.Context, j *claimedJob, batch *preparedBatch, errs *[]rowError, res *processResult) error {
	if !hasMappedCustomFields(j.Mapping) {
		return nil
	}
	if !j.CustomFieldPolicy.resolved {
		// Defensive path for direct/internal callers: processJob resolves the
		// policy at the execution boundary before the chunk loop.
		policy, err := resolveCustomFieldImportPolicy(ctx, w.Pool, j.TenantID, j.Options.AutoCreateProps)
		if err != nil {
			return err
		}
		j.CustomFieldPolicy = policy
	}
	if !j.CustomFieldPolicy.Validate {
		return nil
	}
	schema := j.CustomFieldSchema
	if schema == nil {
		// Same defensive path: processJob hydrates one immutable snapshot.
		validator := &customfields.Validator{Repo: &customfields.Repo{Pool: w.Pool}}
		var err error
		if schema, err = validator.PrepareReadOnly(ctx, j.TenantID, nil); err != nil {
			return fmt.Errorf("load custom field schema snapshot: %w", err)
		}
	}
	accepted := batch.Accepted[:0]
	for _, candidate := range batch.Accepted {
		var fields map[string]any
		if err := json.Unmarshal(candidate.CustomJSON, &fields); err != nil {
			*errs = append(*errs, rowError{RowNumber: candidate.RowNumber, Code: "custom_fields_invalid", Message: "Custom fields could not be decoded"})
			res.Failed++
			continue
		}
		canonical, err := schema.Validate(fields)
		if err != nil {
			code, message := customFieldRowFailure(err, schema, j.CustomFieldPolicy)
			*errs = append(*errs, rowError{RowNumber: candidate.RowNumber, Code: code, Message: message})
			res.Failed++
			continue
		}
		if candidate.CustomJSON, err = json.Marshal(canonical); err != nil {
			*errs = append(*errs, rowError{RowNumber: candidate.RowNumber, Code: "custom_fields_invalid", Message: "Custom fields could not be encoded"})
			res.Failed++
			continue
		}
		accepted = append(accepted, candidate)
	}
	batch.Accepted = accepted
	return nil
}
