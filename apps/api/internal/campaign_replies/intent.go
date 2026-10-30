// SPDX-License-Identifier: AGPL-3.0-only

package campaign_replies

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
)

var ErrClassifierUnavailable = errors.New("campaign_replies: classifier unavailable")

type IntentResult struct {
	Label      string
	Confidence float64
	Classifier string
}

type IntentClassifier interface {
	ClassifyReply(ctx context.Context, tenantID, subject, body string) (IntentResult, error)
}

type AIIntentClassifier struct {
	Voice aicompose.VoiceClient
}

func NewAIIntentClassifier(voice aicompose.VoiceClient) *AIIntentClassifier {
	return &AIIntentClassifier{Voice: voice}
}

func (c *AIIntentClassifier) ClassifyReply(ctx context.Context, tenantID, subject, body string) (IntentResult, error) {
	if fast, ok := classifyHeuristic(subject, body); ok && fast.Confidence >= 0.85 {
		return fast, nil
	}
	if c == nil || c.Voice == nil {
		return IntentResult{}, ErrClassifierUnavailable
	}
	prompt := `Classify this email reply intent.

Return only compact JSON:
{"intent_class":"question|praise|unsub|ooo|other","confidence":0.0}

Use:
- question: asks a question or needs a reply
- praise: positive testimonial, thanks, success, or enthusiasm
- unsub: unsubscribe, stop, remove me, complaint about receiving mail
- ooo: out-of-office, vacation, auto-reply
- other: everything else`
	contextText := "Subject: " + strings.TrimSpace(subject) + "\n\nBody:\n" + trim(body, 6000)
	out, err := c.Voice.Generate(ctx, tenantID, aicompose.KindReplyIntent, prompt, contextText)
	if err != nil {
		if errors.Is(err, aicompose.ErrVoiceUnavailable) {
			if fast, ok := classifyHeuristic(subject, body); ok {
				return fast, nil
			}
			return IntentResult{}, ErrClassifierUnavailable
		}
		return IntentResult{}, err
	}
	res, err := parseIntentJSON(out.Text)
	if err != nil {
		if fast, ok := classifyHeuristic(subject, body); ok {
			return fast, nil
		}
		return IntentResult{Label: "other", Confidence: 0.4, Classifier: "ai"}, nil
	}
	res.Classifier = "ai"
	return res, nil
}

func classifyHeuristic(subject, body string) (IntentResult, bool) {
	s := strings.ToLower(strings.TrimSpace(subject))
	b := strings.ToLower(strings.TrimSpace(body))
	joined := s + "\n" + b
	switch {
	case strings.HasPrefix(s, "out of office"),
		strings.HasPrefix(s, "automatic reply"),
		strings.Contains(joined, "out of office"),
		strings.Contains(joined, "auto-reply"),
		strings.Contains(joined, "vacation"):
		return IntentResult{Label: "ooo", Confidence: 0.95, Classifier: "heuristic"}, true
	case strings.Contains(joined, "unsubscribe"),
		strings.Contains(joined, "remove me"),
		strings.Contains(joined, "stop emailing"),
		strings.Contains(joined, "take me off"):
		return IntentResult{Label: "unsub", Confidence: 0.92, Classifier: "heuristic"}, true
	case strings.Contains(joined, "?"),
		hasAnyPrefix(s, "why ", "how ", "what ", "when ", "where ", "can ", "could ", "would ", "do you ", "does "):
		return IntentResult{Label: "question", Confidence: 0.86, Classifier: "heuristic"}, true
	case strings.Contains(joined, "thank you"),
		strings.Contains(joined, "thanks"),
		strings.Contains(joined, "love this"),
		strings.Contains(joined, "great"),
		strings.Contains(joined, "amazing"),
		strings.Contains(joined, "helpful"):
		return IntentResult{Label: "praise", Confidence: 0.82, Classifier: "heuristic"}, true
	default:
		return IntentResult{}, false
	}
}

func parseIntentJSON(text string) (IntentResult, error) {
	text = strings.TrimSpace(text)
	if i := strings.IndexByte(text, '{'); i >= 0 {
		if j := strings.LastIndexByte(text, '}'); j >= i {
			text = text[i : j+1]
		}
	}
	var raw struct {
		IntentClass string  `json:"intent_class"`
		Label       string  `json:"label"`
		Confidence  float64 `json:"confidence"`
	}
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return IntentResult{}, err
	}
	label := normalizeIntent(raw.IntentClass)
	if label == "" {
		label = normalizeIntent(raw.Label)
	}
	if label == "" {
		return IntentResult{}, fmt.Errorf("unknown intent label")
	}
	conf := raw.Confidence
	if conf < 0 {
		conf = 0
	}
	if conf > 1 {
		conf = 1
	}
	if conf == 0 {
		conf = 0.5
	}
	return IntentResult{Label: label, Confidence: conf}, nil
}

func normalizeIntent(s string) string {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "question", "praise", "unsub", "ooo", "other":
		return strings.ToLower(strings.TrimSpace(s))
	case "unsubscribe", "opt_out", "opt-out":
		return "unsub"
	case "out_of_office", "out-of-office", "autoreply", "auto_reply":
		return "ooo"
	}
	return ""
}

func hasAnyPrefix(s string, prefixes ...string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

func trim(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}
