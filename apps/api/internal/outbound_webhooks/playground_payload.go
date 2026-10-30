// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
)

const (
	playgroundJSONMaxBodyBytes              int64 = 512 << 10
	playgroundMaxPayloadBytes                     = 256 << 10
	playgroundMaxPreparedBodyBytes                = 512 << 10
	playgroundMaxPayloadDepth                     = 24
	playgroundMaxPayloadNodes                     = 20_000
	playgroundMaxPayloadObjectFields              = 2_000
	playgroundMaxPayloadKeyBytes                  = 256
	playgroundMaxPayloadStringBytes               = 128 << 10
	playgroundMaxInspectableURLBytes              = 2 << 10
	playgroundMaxInspectableTextBytes             = 4 << 10
	playgroundMaxInspectableHeaderNameBytes       = 256
	playgroundMaxInspectableHeaders               = 128
)

var (
	errPlaygroundPayloadTooLarge     = errors.New("outbound_webhooks: playground payload too large")
	errPlaygroundPayloadTooComplex   = errors.New("outbound_webhooks: playground payload too complex")
	errPlaygroundDuplicateJSONMember = errors.New("outbound_webhooks: duplicate JSON member")
	errPlaygroundExplicitNullPayload = errors.New("outbound_webhooks: explicit null payload")
)

type playgroundFireWireInput struct {
	FireID                       string          `json:"fire_id"`
	EventType                    string          `json:"event_type"`
	ExpectedWebhookConfigVersion *int64          `json:"expected_webhook_config_version"`
	Payload                      json.RawMessage `json:"payload"`
}

// decodePlaygroundFireInput retains exact JSON number spellings in payload,
// rejects duplicate object members at every depth, and distinguishes an
// omitted payload (use the catalog sample) from an explicit null (invalid).
func decodePlaygroundFireInput(r *http.Request) (playgroundFireInput, error) {
	var wire playgroundFireWireInput
	raw, err := httpbody.DecodeJSONBytes(
		r,
		playgroundJSONMaxBodyBytes,
		&wire,
		httpbody.Options{},
	)
	if err != nil {
		return playgroundFireInput{}, err
	}
	if err := rejectDuplicatePlaygroundJSONMembers(raw); err != nil {
		return playgroundFireInput{}, err
	}

	in := playgroundFireInput{
		FireID:                       wire.FireID,
		EventType:                    wire.EventType,
		ExpectedWebhookConfigVersion: wire.ExpectedWebhookConfigVersion,
	}
	if wire.Payload == nil {
		return in, nil
	}
	in.PayloadProvided = true
	if bytes.Equal(bytes.TrimSpace(wire.Payload), []byte("null")) {
		return playgroundFireInput{}, errPlaygroundExplicitNullPayload
	}
	if err := httpbody.DecodeJSONValue(
		wire.Payload,
		&in.Payload,
		httpbody.Options{UseNumber: true},
	); err != nil {
		return playgroundFireInput{}, err
	}
	if in.Payload == nil {
		return playgroundFireInput{}, errPlaygroundExplicitNullPayload
	}
	return in, nil
}

func rejectDuplicatePlaygroundJSONMembers(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := scanPlaygroundJSONValue(decoder, 1); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return httpbody.ErrMultipleJSONValues
		}
		return err
	}
	return nil
}

func scanPlaygroundJSONValue(decoder *json.Decoder, depth int) error {
	if depth > playgroundMaxPayloadDepth+3 {
		return errPlaygroundPayloadTooComplex
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		members := make(map[string]struct{})
		for decoder.More() {
			nameToken, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := nameToken.(string)
			if !ok {
				return errors.New("outbound_webhooks: JSON object member is not a string")
			}
			if _, duplicate := members[name]; duplicate {
				return errPlaygroundDuplicateJSONMember
			}
			members[name] = struct{}{}
			if err := scanPlaygroundJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	case '[':
		for decoder.More() {
			if err := scanPlaygroundJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		_, err = decoder.Token()
		return err
	default:
		return errors.New("outbound_webhooks: invalid JSON delimiter")
	}
}

func validatePlaygroundPayload(payload map[string]any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return errPlaygroundPayloadTooComplex
	}
	if len(encoded) > playgroundMaxPayloadBytes {
		return errPlaygroundPayloadTooLarge
	}
	// Catalog samples are assembled in Go and may contain int or []map values;
	// caller payloads retain json.Number. Walk one canonical JSON decode with
	// UseNumber so both sources are judged by the exact structure that will go
	// on the wire without rejecting or rounding valid high-precision numbers.
	var canonical any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	if err := decoder.Decode(&canonical); err != nil {
		return errPlaygroundPayloadTooComplex
	}
	nodes := 0
	return walkPlaygroundPayload(canonical, 1, &nodes)
}

func walkPlaygroundPayload(value any, depth int, nodes *int) error {
	if depth > playgroundMaxPayloadDepth {
		return errPlaygroundPayloadTooComplex
	}
	*nodes++
	if *nodes > playgroundMaxPayloadNodes {
		return errPlaygroundPayloadTooComplex
	}
	switch typed := value.(type) {
	case map[string]any:
		if len(typed) > playgroundMaxPayloadObjectFields {
			return errPlaygroundPayloadTooComplex
		}
		for key, child := range typed {
			if key == "" || len(key) > playgroundMaxPayloadKeyBytes || !utf8.ValidString(key) ||
				containsPlaygroundControl(key) {
				return errPlaygroundPayloadTooComplex
			}
			if err := walkPlaygroundPayload(child, depth+1, nodes); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := walkPlaygroundPayload(child, depth+1, nodes); err != nil {
				return err
			}
		}
	case string:
		if len(typed) > playgroundMaxPayloadStringBytes || !utf8.ValidString(typed) {
			return errPlaygroundPayloadTooComplex
		}
	case nil, bool, float64, json.Number:
	default:
		return errPlaygroundPayloadTooComplex
	}
	return nil
}

func containsPlaygroundControl(value string) bool {
	for _, char := range value {
		if char <= 0x1f || char == 0x7f {
			return true
		}
	}
	return false
}
