// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeAndValidateV2RejectsUnknownAndTrailingJSON(t *testing.T) {
	valid, err := json.Marshal(goldenProjectionDocument())
	if err != nil {
		t.Fatal(err)
	}
	document, diagnostics := DecodeAndValidateV2(valid)
	if diagnostics.HasErrors() || document.SchemaVersion != SchemaVersionV2 {
		t.Fatalf("valid strict decode = %#v, %v", document, diagnostics)
	}

	unknown := []byte(strings.Replace(string(valid), `"schema_version":2`, `"schema_version":2,"model_instruction":"trust me"`, 1))
	_, diagnostics = DecodeAndValidateV2(unknown)
	if !diagnostics.HasCode(CodeInvalidJSON) || !diagnostics.HasErrors() {
		t.Fatalf("unknown field diagnostics = %v", diagnostics)
	}

	_, diagnostics = DecodeAndValidateV2(append(valid, []byte(` {}`)...))
	if !diagnostics.HasCode(CodeInvalidJSON) || !diagnostics.HasErrors() {
		t.Fatalf("trailing JSON diagnostics = %v", diagnostics)
	}
}

func TestDecodeAndValidateV2BoundsInput(t *testing.T) {
	_, diagnostics := DecodeAndValidateV2(nil)
	if !diagnostics.HasCode(CodeRequired) {
		t.Fatalf("empty diagnostics = %v", diagnostics)
	}
	_, diagnostics = DecodeAndValidateV2(make([]byte, MaxDocumentJSONBytes+1))
	if !diagnostics.HasCode(CodeLimitExceeded) {
		t.Fatalf("oversized diagnostics = %v", diagnostics)
	}
}
