// SPDX-License-Identifier: AGPL-3.0-only
package outbound_webhooks

import (
	"encoding/json"
	"errors"
)

// preparedDelivery is the exact body decision shared by live workers and
// operator test surfaces. Keeping one implementation prevents a successful
// test from bypassing the filter or transform that production will apply.
type preparedDelivery struct {
	Body     []byte
	Filtered bool
}

func prepareDelivery(cfg *DeliveryConfig, envelope map[string]any) (preparedDelivery, error) {
	if cfg == nil {
		return preparedDelivery{}, errors.New("delivery configuration unavailable")
	}
	if cfg.Filter != nil && !cfg.Filter.Matches(envelope) {
		return preparedDelivery{Filtered: true}, nil
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return preparedDelivery{}, err
	}
	if len(cfg.Transform) > 0 {
		body, err = Transform(cfg.Transform, body)
		if err != nil {
			return preparedDelivery{}, err
		}
	}
	return preparedDelivery{Body: body}, nil
}
