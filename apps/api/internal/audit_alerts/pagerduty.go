// SPDX-License-Identifier: AGPL-3.0-only
//
// pagerduty.go — PagerDuty incident creation via Events API v2
// (https://events.pagerduty.com/v2/enqueue). Events API uses an
// integration key ("routing_key") rather than a global API token,
// which is the lowest-friction setup for an operator (one key per
// service in PagerDuty UI).
//
// channel_config shape for kind='pagerduty':
//   {
//     "routing_key":   "<32-char integration key>",
//     "severity":      "warning",   // info | warning | error | critical
//     "source":        "postwave-audit",
//     "rest_api_token": "<optional, enables status sync via REST>"
//   }

package audit_alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// pagerDutyEvent is the Events API v2 payload.
type pagerDutyEvent struct {
	RoutingKey  string           `json:"routing_key"`
	EventAction string           `json:"event_action"`
	DedupKey    string           `json:"dedup_key,omitempty"`
	Payload     pagerDutyPayload `json:"payload"`
	Links       []pagerDutyLink  `json:"links,omitempty"`
}

type pagerDutyPayload struct {
	Summary       string         `json:"summary"`
	Source        string         `json:"source"`
	Severity      string         `json:"severity"`
	Timestamp     string         `json:"timestamp,omitempty"`
	Component     string         `json:"component,omitempty"`
	Group         string         `json:"group,omitempty"`
	Class         string         `json:"class,omitempty"`
	CustomDetails map[string]any `json:"custom_details,omitempty"`
}

type pagerDutyLink struct {
	Href string `json:"href"`
	Text string `json:"text"`
}

type pagerDutyEventResp struct {
	Status   string `json:"status"`
	Message  string `json:"message"`
	DedupKey string `json:"dedup_key"`
}

// createPagerDutyIncident enqueues a trigger event. Returns
// (externalID=dedup_key, deepLinkURL=PagerDuty incident URL).
//
// We construct the deep link using the events.pagerduty.com fallback
// because the Events API only returns dedup_key, not a permalink.
// Real production wiring can call the REST API to resolve the
// incident URL given the dedup_key, but that requires a separate
// API token and is optional.
func createPagerDutyIncident(
	ctx context.Context, client *http.Client,
	config map[string]any, env fireEnvelope, reason string,
) (string, string, error) {
	routingKey := asString(config["routing_key"])
	if routingKey == "" {
		return "", "", fmt.Errorf("pagerduty: routing_key required")
	}
	severity := strings.ToLower(asString(config["severity"]))
	switch severity {
	case "info", "warning", "error", "critical":
	default:
		severity = "warning"
	}
	source := asString(config["source"])
	if source == "" {
		source = "postwave-audit"
	}
	// dedup_key: stable per (rule, audit_id) so retries don't create
	// duplicate incidents.
	dedupKey := fmt.Sprintf("postwave-rule-%s-audit-%d", env.RuleID, env.AuditID)
	event := pagerDutyEvent{
		RoutingKey:  routingKey,
		EventAction: "trigger",
		DedupKey:    dedupKey,
		Payload: pagerDutyPayload{
			Summary:   fmt.Sprintf("[Moosewave] %s — %s", env.RuleName, env.Action),
			Source:    source,
			Severity:  severity,
			Timestamp: env.At,
			Component: env.ResourceType,
			Group:     env.ActorType,
			Class:     "audit_alert",
			CustomDetails: map[string]any{
				"rule_id":       env.RuleID,
				"rule_name":     env.RuleName,
				"action":        env.Action,
				"actor_label":   env.ActorLabel,
				"resource_id":   env.ResourceID,
				"resource_type": env.ResourceType,
				"audit_id":      env.AuditID,
				"reason":        reason,
			},
		},
	}
	body, _ := json.Marshal(event)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://events.pagerduty.com/v2/enqueue", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("pagerduty %s", resp.Status)
	}
	var decoded pagerDutyEventResp
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", "", err
	}
	if decoded.Status != "success" {
		return "", "", fmt.Errorf("pagerduty: %s (%s)", decoded.Status, decoded.Message)
	}
	deepLink := fmt.Sprintf("https://app.pagerduty.com/incidents?query=%s", decoded.DedupKey)
	return decoded.DedupKey, deepLink, nil
}

// resolvePagerDutyIncident sends an event_action=resolve event for
// the same dedup_key. Used by inbound webhook handlers to bridge
// status updates (e.g., PagerDuty admin resolves on phone, the
// next inbound webhook tells us to mark resolved here).
func resolvePagerDutyIncident(
	ctx context.Context, client *http.Client,
	config map[string]any, dedupKey string,
) error {
	routingKey := asString(config["routing_key"])
	if routingKey == "" || dedupKey == "" {
		return fmt.Errorf("pagerduty: routing_key + dedup_key required")
	}
	event := map[string]any{
		"routing_key":  routingKey,
		"event_action": "resolve",
		"dedup_key":    dedupKey,
	}
	body, _ := json.Marshal(event)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://events.pagerduty.com/v2/enqueue", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("pagerduty resolve %s", resp.Status)
	}
	return nil
}
