// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// TransientRequestEvidence is the bounded, non-persisted HTTP evidence used by
// features such as poll confirmation. It deliberately exposes only signals the
// v2 methodology already understands; callers cannot invent a second scoring
// model or smuggle recipient identity into the classifier.
type TransientRequestEvidence struct {
	UserAgent       string
	IP              string
	HeaderNames     []string
	HeadersComplete bool
}

// ClassifyTransientRequest evaluates one HTTP interaction with the exact
// immutable classifier and machine-source registry held by this Runtime. The
// synthetic canonical identity exists only to satisfy the classifier's common
// validation envelope: no observation, identity, IP, or header is persisted.
//
// This method does not reinterpret shadow mode and does not manufacture a
// human verdict. A caller that has a separate explicit-human decision (for
// example, a one-time browser confirmation form) must keep that evidence and
// policy distinct; a v2 machine verdict remains authoritative machine evidence.
func (runtime *Runtime) ClassifyTransientRequest(
	evidence TransientRequestEvidence,
) (ClassificationResult, error) {
	if runtime == nil || !runtime.enabled {
		return ClassificationResult{}, ErrRuntimeDisabled
	}
	if runtime.hook == nil || runtime.hook.Classifier == nil {
		return ClassificationResult{}, ErrRuntimeNotReady
	}
	now := time.Now().UTC()
	if runtime.now != nil {
		now = runtime.now().UTC()
	}

	names := make([]string, 0, len(evidence.HeaderNames))
	seen := make(map[string]struct{}, len(evidence.HeaderNames))
	for _, raw := range evidence.HeaderNames {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		canonical := strings.ToLower(name)
		if _, duplicate := seen[canonical]; duplicate {
			continue
		}
		seen[canonical] = struct{}{}
		names = append(names, name)
	}
	if len(names) > 128 {
		return ClassificationResult{}, fmt.Errorf(
			"%w: transient request has more than 128 header names", ErrInvalidInput)
	}
	sort.Slice(names, func(i, j int) bool {
		return strings.ToLower(names[i]) < strings.ToLower(names[j])
	})
	headers := make([]Header, 0, len(names))
	for _, name := range names {
		headers = append(headers, Header{Name: name})
	}

	return runtime.hook.Classifier.Classify(ObservationInput{
		EventRef: EventRef{ID: 1, At: now},
		Source:   "poll.confirmation", SourceEventID: "transient",
		IdempotencyKey:     "poll-confirmation:transient",
		EventSchemaVersion: ObservationSchemaV1,
		EventType:          "clicked", OccurredAt: now, IngestedAt: now,
		OrderedHeaders: headers, OrderedHeadersComplete: evidence.HeadersComplete,
		UserAgent:       strings.TrimSpace(evidence.UserAgent),
		IP:              strings.TrimSpace(evidence.IP),
		ProviderSignals: map[string]any{},
		PrivacyExpiryAt: now.Add(DefaultFullFidelityWindow),
	}, MessageAggregate{})
}
