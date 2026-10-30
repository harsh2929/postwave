// SPDX-License-Identifier: AGPL-3.0-only
//
// servicenow.go — ServiceNow incident creation via the Table API
// (/api/now/table/incident). Uses Basic auth with an instance API
// user, or a bearer token if channel_config.bearer_token is set.
//
// channel_config shape for kind='servicenow':
//   {
//     "instance_url":  "https://acme.service-now.com",
//     "username":      "postwave_integration",
//     "password":      "<api-user-pwd>",
//     "bearer_token":  "<optional, replaces basic auth>",
//     "assignment_group": "Security",
//     "impact":         2,
//     "urgency":        2
//   }
//
// The created incident's sys_id + permalink are returned so the
// worker can persist an audit_alert_incidents row for bidirectional
// status sync.

package audit_alerts

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

type serviceNowIncidentResp struct {
	Result struct {
		SysID  string `json:"sys_id"`
		Number string `json:"number"`
	} `json:"result"`
}

// createServiceNowIncident POSTs a new incident to the configured
// instance and returns (externalID=sys_id, deepLinkURL).
func createServiceNowIncident(
	ctx context.Context, client *http.Client,
	config map[string]any, env fireEnvelope, reason string,
) (string, string, error) {
	instanceURL, _ := config["instance_url"].(string)
	instanceURL = strings.TrimRight(strings.TrimSpace(instanceURL), "/")
	if !strings.HasPrefix(instanceURL, "https://") {
		return "", "", fmt.Errorf("servicenow: instance_url must start with https://")
	}
	// Compose the incident body. short_description gets the rule
	// name; description carries the audit envelope + reason for
	// detective debugging.
	payload := map[string]any{
		"short_description": fmt.Sprintf("[Moosewave] %s — %s",
			env.RuleName, env.Action),
		"description": formatIncidentBody(env, reason),
		"caller_id":   firstNonEmpty(asString(config["caller_id"]), "postwave"),
	}
	if g := asString(config["assignment_group"]); g != "" {
		payload["assignment_group"] = g
	}
	if v := asInt(config["impact"]); v > 0 {
		payload["impact"] = v
	}
	if v := asInt(config["urgency"]); v > 0 {
		payload["urgency"] = v
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		instanceURL+"/api/now/table/incident", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	applyServiceNowAuth(req, config)
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("servicenow %s", resp.Status)
	}
	var decoded serviceNowIncidentResp
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", "", err
	}
	if decoded.Result.SysID == "" {
		return "", "", fmt.Errorf("servicenow: no sys_id in response")
	}
	deepLink := fmt.Sprintf("%s/nav_to.do?uri=incident.do?sys_id=%s",
		instanceURL, decoded.Result.SysID)
	return decoded.Result.SysID, deepLink, nil
}

// fetchServiceNowIncidentState reads the current state for an
// incident; used by the optional periodic sync path. Returns a
// normalised status: "open"|"in_progress"|"resolved"|"closed"|"".
func fetchServiceNowIncidentState(
	ctx context.Context, client *http.Client,
	config map[string]any, sysID string,
) (string, error) {
	instanceURL := strings.TrimRight(asString(config["instance_url"]), "/")
	if instanceURL == "" || sysID == "" {
		return "", fmt.Errorf("servicenow: missing instance_url or sys_id")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/api/now/table/incident/%s?sysparm_fields=state",
			instanceURL, sysID), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	applyServiceNowAuth(req, config)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("servicenow %s", resp.Status)
	}
	var payload struct {
		Result struct {
			State string `json:"state"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	return normaliseServiceNowState(payload.Result.State), nil
}

func applyServiceNowAuth(req *http.Request, config map[string]any) {
	if tok := asString(config["bearer_token"]); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
		return
	}
	user := asString(config["username"])
	pass := asString(config["password"])
	if user != "" || pass != "" {
		creds := base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
		req.Header.Set("Authorization", "Basic "+creds)
	}
}

// normaliseServiceNowState maps ServiceNow numeric state codes to
// our cross-system vocabulary. SN states: 1=New, 2=In Progress,
// 3=On Hold, 6=Resolved, 7=Closed, 8=Canceled.
func normaliseServiceNowState(state string) string {
	switch strings.TrimSpace(state) {
	case "1":
		return "open"
	case "2":
		return "in_progress"
	case "3":
		return "in_progress"
	case "6":
		return "resolved"
	case "7":
		return "closed"
	case "8":
		return "closed"
	default:
		return ""
	}
}

func formatIncidentBody(env fireEnvelope, reason string) string {
	return fmt.Sprintf(
		"Rule: %s\nAudit event id: %d\nAction: %s\nActor: %s (%s)\nResource: %s/%s\nWhen: %s\nReason: %s\n",
		env.RuleName, env.AuditID, env.Action, env.ActorLabel,
		env.ActorType, env.ResourceType, env.ResourceID, env.At, reason)
}

func asString(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
