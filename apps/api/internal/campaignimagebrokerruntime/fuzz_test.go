// SPDX-License-Identifier: AGPL-3.0-only

package campaignimagebrokerruntime

import "testing"

func FuzzDecodeWireResponseNeverAcceptsWrongIdentity(f *testing.F) {
	valid := []byte(`{"protocol":"postwave.campaign-image-ipc.v1","operation":"ready","status":"ready","engine":"ocr","version":"v1"}`)
	f.Add(valid)
	f.Add([]byte(`{"protocol":"other","operation":"ready","status":"ready","engine":"ocr","version":"v1"}`))
	f.Add([]byte{0xff, 0x00, '{'})
	f.Fuzz(func(t *testing.T, body []byte) {
		response, err := decodeWireResponse(body, 64<<10, wireRequest{
			Protocol: ProtocolVersion, Operation: "ready", Engine: "ocr", Version: "v1",
		})
		if err == nil && (response.Protocol != ProtocolVersion || response.Operation != "ready" ||
			response.Engine != "ocr" || response.Version != "v1") {
			t.Fatalf("accepted wrong response identity: %+v", response)
		}
	})
}
