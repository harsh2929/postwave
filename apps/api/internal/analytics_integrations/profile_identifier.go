// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"encoding/json"
	"fmt"
)

// Providers return both string and numeric profile IDs. Preserve numeric IDs
// verbatim, including integers beyond float64's exact range.
type analyticsProfileID string

func (id *analyticsProfileID) UnmarshalJSON(raw []byte) error {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		*id = analyticsProfileID(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return fmt.Errorf("analytics profile identifier must be a string or number")
	}
	*id = analyticsProfileID(number.String())
	return nil
}

func (id analyticsProfileID) String() string { return string(id) }
