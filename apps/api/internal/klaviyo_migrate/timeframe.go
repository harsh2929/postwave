// SPDX-License-Identifier: AGPL-3.0-only
//
// timeframe.go — pure conversion of {value, unit} → ISO8601
// timestamp at translation time. We anchor the "now" used for the
// arithmetic externally so unit tests are deterministic.

package klaviyo_migrate

import (
	"strings"
	"time"
)

// timeNow is the seam translateMetricCondition uses to produce
// timestamps. Tests can override; production uses time.Now.
var timeNow = time.Now

// isoSinceTimeframe returns now-d, where d is derived from a Klaviyo
// timeframe descriptor. Returns false on unrecognised units.
func isoSinceTimeframe(tf klaviyoTimeframe) (string, bool) {
	d, ok := timeframeDuration(tf)
	if !ok {
		return "", false
	}
	return timeNow().UTC().Add(-d).Format(time.RFC3339), true
}

func timeframeDuration(tf klaviyoTimeframe) (time.Duration, bool) {
	if tf.Value < 0 {
		return 0, false
	}
	switch strings.ToLower(strings.TrimSpace(tf.Unit)) {
	case "hour", "hours", "h":
		return time.Duration(tf.Value) * time.Hour, true
	case "day", "days", "d":
		return time.Duration(tf.Value) * 24 * time.Hour, true
	case "week", "weeks", "w":
		return time.Duration(tf.Value) * 7 * 24 * time.Hour, true
	case "month", "months":
		// Approximate to 30 days — Klaviyo's month-since semantics
		// are calendar-based, but Moosewave's comparator is timestamp
		// arithmetic; surfacing the approximation in a warning would
		// be confusing for end-users, so we accept the rounding.
		return time.Duration(tf.Value) * 30 * 24 * time.Hour, true
	}
	return 0, false
}
