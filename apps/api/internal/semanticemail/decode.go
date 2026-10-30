// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const MaxDocumentJSONBytes = 8 << 20

// DecodeAndValidateV2 is the strict JSON authoring/freeze boundary. It rejects
// unknown fields and trailing values before normalization so new or
// model-generated keys cannot be silently discarded and falsely certified.
func DecodeAndValidateV2(raw json.RawMessage) (DocumentV2, Diagnostics) {
	diagnostics := Diagnostics{}
	if len(raw) == 0 {
		diagnostics.error("/", "", CodeRequired, "semantic document JSON is required")
		return DocumentV2{}, diagnostics
	}
	if len(raw) > MaxDocumentJSONBytes {
		diagnostics.error("/", "", CodeLimitExceeded, fmt.Sprintf("semantic document JSON exceeds %d bytes", MaxDocumentJSONBytes))
		return DocumentV2{}, diagnostics
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var document DocumentV2
	if err := decoder.Decode(&document); err != nil {
		diagnostics.error("/", "", CodeInvalidJSON, "semantic document JSON could not be decoded: "+err.Error())
		return DocumentV2{}, diagnostics
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		diagnostics.error("/", "", CodeInvalidJSON, "semantic document JSON must contain exactly one value")
		return DocumentV2{}, diagnostics
	}
	normalized, validation := NormalizeAndValidateV2(document)
	return normalized, validation
}
