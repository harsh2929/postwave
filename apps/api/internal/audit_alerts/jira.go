// SPDX-License-Identifier: AGPL-3.0-only
//
// jira.go — Jira Cloud issue creation via REST v3
// (/rest/api/3/issue). Uses email + API token (Basic auth) which is
// the recommended path for Jira Cloud integrations.
//
// channel_config shape for kind='jira':
//   {
//     "site_url":   "https://acme.atlassian.net",
//     "email":      "integrations@acme.com",
//     "api_token":  "<atlassian-api-token>",
//     "project_key":"SEC",
//     "issue_type": "Incident"
//   }

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

type jiraIssueResp struct {
	ID  string `json:"id"`
	Key string `json:"key"`
}

// createJiraIssue POSTs a new issue and returns (externalID=issueKey,
// deepLinkURL). The Jira issue key is used because it's stable and
// human-readable (e.g. SEC-1234).
func createJiraIssue(
	ctx context.Context, client *http.Client,
	config map[string]any, env fireEnvelope, reason string,
) (string, string, error) {
	site := strings.TrimRight(asString(config["site_url"]), "/")
	if !strings.HasPrefix(site, "https://") {
		return "", "", fmt.Errorf("jira: site_url must start with https://")
	}
	projectKey := asString(config["project_key"])
	if projectKey == "" {
		return "", "", fmt.Errorf("jira: project_key required")
	}
	issueType := asString(config["issue_type"])
	if issueType == "" {
		issueType = "Task"
	}
	// Jira's v3 description requires Atlassian Document Format. We
	// nest the audit body as a single paragraph; this keeps the
	// payload light without an ADF helper dep.
	fields := map[string]any{
		"project":     map[string]any{"key": projectKey},
		"summary":     fmt.Sprintf("[Moosewave] %s — %s", env.RuleName, env.Action),
		"issuetype":   map[string]any{"name": issueType},
		"description": adfParagraph(formatIncidentBody(env, reason)),
	}
	payload := map[string]any{"fields": fields}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		site+"/rest/api/3/issue", bytes.NewReader(body))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	applyJiraAuth(req, config)
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("jira %s", resp.Status)
	}
	var decoded jiraIssueResp
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", "", err
	}
	if decoded.Key == "" {
		return "", "", fmt.Errorf("jira: no issue key in response")
	}
	deepLink := fmt.Sprintf("%s/browse/%s", site, decoded.Key)
	return decoded.Key, deepLink, nil
}

// fetchJiraIssueState normalises the current statusCategory of an
// issue. Atlassian's statusCategory is "new"|"indeterminate"|"done".
func fetchJiraIssueState(
	ctx context.Context, client *http.Client,
	config map[string]any, issueKey string,
) (string, error) {
	site := strings.TrimRight(asString(config["site_url"]), "/")
	if site == "" || issueKey == "" {
		return "", fmt.Errorf("jira: missing site_url or issue_key")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/rest/api/3/issue/%s?fields=status",
			site, issueKey), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	applyJiraAuth(req, config)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return "", fmt.Errorf("jira %s", resp.Status)
	}
	var payload struct {
		Fields struct {
			Status struct {
				StatusCategory struct {
					Key string `json:"key"`
				} `json:"statusCategory"`
			} `json:"status"`
		} `json:"fields"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	return normaliseJiraCategory(payload.Fields.Status.StatusCategory.Key), nil
}

func applyJiraAuth(req *http.Request, config map[string]any) {
	email := asString(config["email"])
	token := asString(config["api_token"])
	if email == "" || token == "" {
		return
	}
	creds := base64.StdEncoding.EncodeToString([]byte(email + ":" + token))
	req.Header.Set("Authorization", "Basic "+creds)
}

func normaliseJiraCategory(cat string) string {
	switch strings.ToLower(cat) {
	case "new":
		return "open"
	case "indeterminate":
		return "in_progress"
	case "done":
		return "resolved"
	}
	return ""
}

// adfParagraph wraps prose in the minimal Atlassian Document Format
// envelope that Jira v3 requires for the description field.
func adfParagraph(text string) map[string]any {
	return map[string]any{
		"type":    "doc",
		"version": 1,
		"content": []any{
			map[string]any{
				"type": "paragraph",
				"content": []any{
					map[string]any{"type": "text", "text": text},
				},
			},
		},
	}
}
