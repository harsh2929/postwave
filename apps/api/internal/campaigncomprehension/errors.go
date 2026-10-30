// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"fmt"
	"strings"
)

type ValidationCode string

const (
	CodeInvalidJSON         ValidationCode = "invalid_json"
	CodeTrailingJSON        ValidationCode = "trailing_json"
	CodeDuplicateKey        ValidationCode = "duplicate_key"
	CodeUnknownField        ValidationCode = "unknown_field"
	CodeInputTooLarge       ValidationCode = "input_too_large"
	CodeRequired            ValidationCode = "required"
	CodeInvalidSchema       ValidationCode = "schema_version_unsupported"
	CodeInvalidText         ValidationCode = "invalid_text"
	CodeTextTooLong         ValidationCode = "text_too_long"
	CodeLimitExceeded       ValidationCode = "limit_exceeded"
	CodeInvalidReference    ValidationCode = "invalid_stable_reference"
	CodeDuplicate           ValidationCode = "duplicate"
	CodeEvidenceNotAllowed  ValidationCode = "evidence_not_allowed"
	CodeInvalidEnum         ValidationCode = "invalid_enum"
	CodeInvalidURL          ValidationCode = "invalid_url"
	CodeURLCredentials      ValidationCode = "url_credentials_forbidden"
	CodeURLFragment         ValidationCode = "url_fragment_forbidden"
	CodeValueTypeMismatch   ValidationCode = "value_type_mismatch"
	CodeInvalidDateTime     ValidationCode = "datetime_invalid_rfc3339"
	CodeTimezoneUnknown     ValidationCode = "timezone_unknown"
	CodeTimezoneOffset      ValidationCode = "timezone_offset_mismatch"
	CodeInvalidDecimal      ValidationCode = "decimal_invalid"
	CodeDecimalLimit        ValidationCode = "decimal_precision_exceeded"
	CodeNumberOutOfRange    ValidationCode = "number_out_of_range"
	CodeInvalidCurrency     ValidationCode = "currency_invalid_iso4217"
	CodeReceiptHashMismatch ValidationCode = "receipt_hash_mismatch"
)

type ValidationError struct {
	Path    string         `json:"path"`
	Code    ValidationCode `json:"code"`
	Message string         `json:"message"`
}

type ValidationErrors []ValidationError

func (e ValidationErrors) Error() string {
	parts := make([]string, 0, len(e))
	for _, item := range e {
		parts = append(parts, fmt.Sprintf("%s [%s]: %s", item.Path, item.Code, item.Message))
	}
	return strings.Join(parts, "; ")
}

func (e ValidationErrors) HasCode(code ValidationCode) bool {
	for _, item := range e {
		if item.Code == code {
			return true
		}
	}
	return false
}

func (e *ValidationErrors) add(path string, code ValidationCode, message string) {
	*e = append(*e, ValidationError{Path: path, Code: code, Message: message})
}
