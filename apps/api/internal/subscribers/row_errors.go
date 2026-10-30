// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/customfields"
)

// erasureBlockedMessage explains ErrErasureBlocked to the person who tried to
// add the address. The tombstone is irreversible through suppression
// management (suppressions.ErrIrreversibleSuppression), so the message offers
// no action that does not exist.
const erasureBlockedMessage = "This address was permanently erased by a contact deletion or privacy request and can't be re-added."

// subscriberRowError is the public, per-record failure contract shared by the
// synchronous subscriber import surfaces. Message is deliberately suitable
// for an API response: database diagnostics remain available to server-side
// logging, but SQL, constraint names, and stored values never cross the wire.
type subscriberRowError struct {
	Code    string
	Message string
}

func validationRowError(err error) subscriberRowError {
	if err == nil {
		return subscriberRowError{}
	}
	var unknown *customfields.ErrUnknownKey
	if errors.As(err, &unknown) {
		return subscriberRowError{
			Code:    "unknown_custom_field",
			Message: "a custom field is not declared for this audience",
		}
	}
	var mismatch *customfields.ErrTypeMismatch
	if errors.As(err, &mismatch) {
		return subscriberRowError{
			Code:    "custom_field_type_mismatch",
			Message: "a custom field value does not match its declared type",
		}
	}
	var violation *customfields.ErrValueViolation
	if errors.As(err, &violation) {
		return subscriberRowError{
			Code:    "custom_field_validation_failed",
			Message: "a custom field value violates its declared constraints",
		}
	}
	return subscriberRowError{Code: "validation_failed", Message: err.Error()}
}

func engineRowError(error) subscriberRowError {
	return subscriberRowError{
		Code:    "engine_sync_failed",
		Message: "subscriber could not be synchronized with the delivery engine",
	}
}

func persistenceRowError(err error) subscriberRowError {
	if err == nil {
		return subscriberRowError{}
	}
	if errors.Is(err, ErrErasureBlocked) {
		return subscriberRowError{
			Code:    "erasure_blocked",
			Message: erasureBlockedMessage,
		}
	}

	// Validator failures can be wrapped by Repo.Upsert before persistence.
	if rowErr := validationRowError(err); rowErr.Code != "validation_failed" {
		return rowErr
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "PW001":
			return subscriberRowError{
				Code:    "merge_field_validation_failed",
				Message: "a merge field value is invalid",
			}
		case "PW002":
			return subscriberRowError{
				Code:    "merge_field_in_use",
				Message: "a merge field has stored subscriber values",
			}
		case "23505":
			return subscriberRowError{
				Code:    "subscriber_conflict",
				Message: "subscriber conflicts with an existing record",
			}
		case "23503":
			return subscriberRowError{
				Code:    "reference_conflict",
				Message: "subscriber references an unavailable record",
			}
		case "23502", "23514", "22001", "22P02":
			return subscriberRowError{
				Code:    "subscriber_data_invalid",
				Message: "subscriber data violates a storage constraint",
			}
		default:
			if strings.HasPrefix(pgErr.Code, "22") || strings.HasPrefix(pgErr.Code, "23") {
				return subscriberRowError{
					Code:    "subscriber_data_invalid",
					Message: "subscriber data violates a storage constraint",
				}
			}
			return subscriberRowError{
				Code:    "subscriber_write_failed",
				Message: "subscriber could not be saved",
			}
		}
	}

	return subscriberRowError{
		Code:    "subscriber_write_failed",
		Message: "subscriber could not be saved",
	}
}
