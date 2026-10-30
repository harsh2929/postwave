package views

import (
	"encoding/json"
	"errors"
)

// The ops proxy accepts at most 1 MiB from a view endpoint. Keep enough
// headroom for the proxy's own error envelope while ensuring a valid incident
// containing many maximally escaped update bodies remains readable.
const maxIncidentTimelineResponseBytes = 900 << 10

var errIncidentTimelineResponseTooLarge = errors.New("incident timeline response cannot fit within its byte ceiling")

// boundIncidentTimelineResponse retains the newest chronological suffix that
// can be encoded within the response ceiling. IncidentTimeline already caps
// row count; this second bound is necessary because JSON escaping can make a
// valid 16 KiB UTF-8 update substantially larger on the wire.
func boundIncidentTimelineResponse(detail *IncidentDetail) error {
	if detail == nil {
		return errors.New("incident timeline is nil")
	}

	encoded, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	// json.Encoder appends exactly one newline to the marshaled document.
	if len(encoded)+1 <= maxIncidentTimelineResponseBytes {
		return nil
	}

	original := detail.Updates
	base := *detail
	base.Updates = []IncidentUpdate{}
	base.UpdatesTruncated = true
	// Reserve the exact wire width of the UUID cursor before selecting the
	// suffix. The actual cursor becomes the oldest retained update below.
	base.NextBefore = "00000000-0000-4000-8000-000000000000"
	encodedBase, err := json.Marshal(&base)
	if err != nil {
		return err
	}
	remaining := maxIncidentTimelineResponseBytes - 1 - len(encodedBase)
	if remaining < 0 {
		return errIncidentTimelineResponseTooLarge
	}

	start := len(original)
	used := 0
	for i := len(original) - 1; i >= 0; i-- {
		item, marshalErr := json.Marshal(original[i])
		if marshalErr != nil {
			return marshalErr
		}
		delta := len(item)
		if start < len(original) {
			delta++ // comma between adjacent array elements
		}
		if delta > remaining-used {
			break
		}
		used += delta
		start = i
	}
	if len(original) > 0 && start == len(original) {
		return errIncidentTimelineResponseTooLarge
	}

	detail.Updates = original[start:]
	detail.UpdatesTruncated = true
	detail.NextBefore = detail.Updates[0].ID
	encoded, err = json.Marshal(detail)
	if err != nil {
		return err
	}
	if len(encoded)+1 > maxIncidentTimelineResponseBytes {
		return errIncidentTimelineResponseTooLarge
	}
	return nil
}
