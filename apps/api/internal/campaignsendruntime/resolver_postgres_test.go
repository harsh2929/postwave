// SPDX-License-Identifier: AGPL-3.0-only

package campaignsendruntime

import (
	"reflect"
	"testing"
)

func TestDecodeScalarObjectAcceptsOnlyDeterministicScalarFields(t *testing.T) {
	got, err := decodeScalarObject([]byte(`{
		"name":"Asha",
		"visits":12,
		"ratio":1.250,
		"active":true,
		"none":null,
		"nested":{"unsafe":true},
		"list":[1,2],
		"_internal":"secret"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"name": "Asha", "visits": "12", "ratio": "1.250", "active": "true",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scalar object = %#v, want %#v", got, want)
	}
}

func TestDecodeScalarObjectRejectsMalformedOrTrailingJSON(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{`, `{} {}`} {
		if _, err := decodeScalarObject([]byte(raw)); err == nil {
			t.Fatalf("decodeScalarObject(%q) succeeded", raw)
		}
	}
}
