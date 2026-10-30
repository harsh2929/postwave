// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/polls"
)

type transientPollClassifier interface {
	ClassifyTransientRequest(
		engagementclassification.TransientRequestEvidence,
	) (engagementclassification.ClassificationResult, error)
}

// pollRequestClassifier composes F14 with the one production F01 runtime. It
// deliberately treats the two evidence sources separately:
//
//   - a v2 machine verdict always excludes the response;
//   - an ordinary or programmatic unknown stays unknown and excluded;
//   - only a same-origin, user-activated browser navigation that consumes the
//     one-time confirmation form is the explicit-human decision promised by
//     the poll flow.
//
// This does not turn unknown F01 traffic into a generic human classification.
type pollRequestClassifier struct {
	Classifier              transientPollClassifier
	TrustForwardedIPHeaders bool
	PublicOrigin            *url.URL
}

func pollRequestClassifierForDeps(
	runtime *engagementclassification.Runtime,
	trustForwardedIPHeaders bool,
	publicBaseURL string,
) (polls.RequestClassifier, error) {
	if runtime == nil || !runtime.Enabled() {
		return nil, nil
	}
	origin, err := url.Parse(strings.TrimSpace(publicBaseURL))
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil {
		return nil, fmt.Errorf("poll classifier public origin is invalid")
	}
	return &pollRequestClassifier{
		Classifier:              runtime,
		TrustForwardedIPHeaders: trustForwardedIPHeaders,
		PublicOrigin:            &url.URL{Scheme: origin.Scheme, Host: origin.Host},
	}, nil
}

func (classifier *pollRequestClassifier) ClassifyRequest(r *http.Request) polls.ClassificationDecision {
	if classifier == nil || classifier.Classifier == nil || r == nil {
		return polls.ClassificationDecision{
			Classification: "unknown", UpstreamClassification: "unknown",
			ClassifierStatus: "unavailable", StableReason: "R_CLASSIFIER_UNAVAILABLE",
		}
	}
	headerNames := make([]string, 0, len(r.Header))
	for name := range r.Header {
		headerNames = append(headerNames, name)
	}
	sort.Slice(headerNames, func(i, j int) bool {
		return strings.ToLower(headerNames[i]) < strings.ToLower(headerNames[j])
	})
	evidence := engagementclassification.TransientRequestEvidence{
		UserAgent:       r.UserAgent(),
		IP:              middleware.ResolveClientIPString(r, classifier.TrustForwardedIPHeaders),
		HeaderNames:     headerNames,
		HeadersComplete: true,
	}
	result, err := classifier.Classifier.ClassifyTransientRequest(evidence)
	evidenceHash := pollTransientEvidenceHash(evidence)
	if err != nil {
		return polls.ClassificationDecision{
			Classification: "unknown", UpstreamClassification: "unknown",
			ClassifierStatus: "unavailable", StableReason: "R_CLASSIFIER_UNAVAILABLE",
			EvidenceSHA256: evidenceHash,
		}
	}
	decision := polls.ClassificationDecision{
		Classification:         string(result.Classification),
		UpstreamClassification: string(result.Classification),
		MachineSubtype:         string(result.MachineSubtype), StableReason: result.StableReason,
		CalibrationBand:    result.CalibrationBand,
		ClassifierVersion:  result.ClassifierVersion,
		MethodologyVersion: result.MethodologyVersion,
		RegistryVersion:    result.RegistryVersion,
		ConfigurationHash:  result.ConfigurationHash,
		ShadowMode:         result.ShadowMode, ClassifierStatus: "ready",
		EvidenceSHA256: evidenceHash,
		Rules:          make([]polls.ClassificationRule, 0, len(result.Rules)),
		Conflicts:      make([]polls.ClassificationConflict, 0, len(result.Conflicts)),
	}
	for _, rule := range result.Rules {
		decision.Rules = append(decision.Rules, polls.ClassificationRule{
			ID: rule.ID, Direction: string(rule.Direction), Weight: rule.Weight,
			SignalConfidence: rule.SignalConfidence, Source: rule.Source,
			MachineSubtype: string(rule.MachineSubtype),
		})
	}
	for _, conflict := range result.Conflicts {
		decision.Conflicts = append(decision.Conflicts, polls.ClassificationConflict{
			Code: conflict.Code, RuleIDs: append([]string(nil), conflict.RuleIDs...),
		})
	}
	switch result.Classification {
	case engagementclassification.Machine:
		decision.Classification = string(engagementclassification.Machine)
	case engagementclassification.Human:
		decision.Classification = string(engagementclassification.Human)
	case engagementclassification.Unknown:
		if classifier.explicitBrowserDecision(r) {
			decision.Classification = string(engagementclassification.Human)
			decision.ExplicitBrowserDecision = true
			decision.StableReason = "R_EXPLICIT_BROWSER_CONFIRMATION"
		}
	default:
		decision.Classification = string(engagementclassification.Unknown)
		decision.UpstreamClassification = string(engagementclassification.Unknown)
		decision.ClassifierStatus = "unavailable"
		decision.StableReason = "R_CLASSIFIER_UNAVAILABLE"
	}
	return decision
}

func pollTransientEvidenceHash(evidence engagementclassification.TransientRequestEvidence) string {
	encoded, _ := json.Marshal(struct {
		Version         int      `json:"version"`
		UserAgent       string   `json:"user_agent"`
		IP              string   `json:"ip"`
		HeaderNames     []string `json:"header_names"`
		HeadersComplete bool     `json:"headers_complete"`
	}{
		Version: 1, UserAgent: evidence.UserAgent, IP: evidence.IP,
		HeaderNames:     append([]string(nil), evidence.HeaderNames...),
		HeadersComplete: evidence.HeadersComplete,
	})
	digest := sha256.Sum256(append([]byte("postwave.poll.transient-request-evidence.v1\x00"), encoded...))
	return hex.EncodeToString(digest[:])
}

func (classifier *pollRequestClassifier) explicitBrowserDecision(r *http.Request) bool {
	if classifier == nil || classifier.PublicOrigin == nil || r == nil ||
		r.Method != http.MethodPost || strings.TrimSpace(r.UserAgent()) == "" ||
		strings.TrimSpace(r.Header.Get("Accept-Language")) == "" ||
		r.Header.Get("Sec-Fetch-User") != "?1" ||
		r.Header.Get("Sec-Fetch-Mode") != "navigate" ||
		r.Header.Get("Sec-Fetch-Dest") != "document" ||
		r.Header.Get("Sec-Fetch-Site") != "same-origin" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/x-www-form-urlencoded") {
		return false
	}
	acceptsHTML := false
	for _, value := range r.Header.Values("Accept") {
		if strings.Contains(strings.ToLower(value), "text/html") {
			acceptsHTML = true
			break
		}
	}
	if !acceptsHTML {
		return false
	}
	origin, err := url.Parse(strings.TrimSpace(r.Header.Get("Origin")))
	if err != nil || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" {
		return false
	}
	return strings.EqualFold(origin.Scheme, classifier.PublicOrigin.Scheme) &&
		strings.EqualFold(origin.Host, classifier.PublicOrigin.Host)
}
