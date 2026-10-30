// SPDX-License-Identifier: MIT

package klaviyo

// Node-translation tests for the expanded Klaviyo flow-action coverage. The
// existing adapter_test.go covers the original happy paths (delay, send-email).
// This file extends coverage to update-profile, list membership, SMS,
// wait-until-condition, conversion goal, and notify-team — the action types
// that previously fell through to the opaque "action" node.

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func actionFromJSON(t *testing.T, id, raw string) kvResource {
	t.Helper()
	return kvResource{ID: id, Type: "flow-action", Attributes: json.RawMessage(raw)}
}

func TestFlowNode_UpdateProfile(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"update-profile",
		"properties":{"plan":"pro","status":"vip"}
	}`))
	require.Equal(t, "update_subscriber", got.Type)
	require.NotNil(t, got.Action)
	require.Equal(t, "update_subscriber", got.Action.Kind)
	require.Equal(t, "pro", got.Action.Properties["plan"])
	require.Equal(t, "vip", got.Action.Properties["status"])
	require.NotEmpty(t, got.RawSource, "raw_source must preserve the original Klaviyo payload")
	require.Equal(t, "update-profile", got.RawSource["action_type"])
}

func TestFlowNode_UpdateProfile_AssignmentsShape(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"update-profile",
		"assignments":[
			{"field":"first_name","value":"Ada"},
			{"property":"plan","value":"pro"}
		]
	}`))
	require.Equal(t, "update_subscriber", got.Type)
	require.Equal(t, "Ada", got.Action.Properties["first_name"])
	require.Equal(t, "pro", got.Action.Properties["plan"])
}

func TestFlowNode_AddToList(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"add-to-list",
		"list_id":"L1"
	}`))
	require.Equal(t, "list_membership", got.Type)
	require.NotNil(t, got.Action)
	require.Equal(t, "list_add", got.Action.Kind)
	require.Equal(t, "L1", got.Action.ListID)
	require.Equal(t, "add-to-list", got.RawSource["action_type"])
}

func TestFlowNode_RemoveFromList(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"remove-from-list",
		"list_id":"L7"
	}`))
	require.Equal(t, "list_membership", got.Type)
	require.Equal(t, "list_remove", got.Action.Kind)
	require.Equal(t, "L7", got.Action.ListID)
}

func TestFlowNode_SendSMS(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"send-sms",
		"body":"Hi {{ first_name }}",
		"template_id":"sms_42"
	}`))
	require.Equal(t, "send_sms", got.Type)
	require.Equal(t, "Hi {{ first_name }}", got.SMSBody)
	require.Equal(t, "send-sms", got.RawSource["action_type"])
}

func TestFlowNode_WaitUntilCondition(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"wait-until-condition",
		"hours":48,
		"type":"profile-property",
		"property":"plan",
		"operator":"equals",
		"value":"pro"
	}`))
	require.Equal(t, "wait_for_condition", got.Type)
	// 48h timeout
	require.EqualValues(t, 48*3600, got.TimeoutSeconds)
	require.NotNil(t, got.Condition)
	require.Equal(t, "condition", got.Condition.Op)
	require.Equal(t, "equals", got.Condition.Comparator)
	require.Equal(t, "pro", got.Condition.Value)
}

func TestFlowNode_SetConversionGoal(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"set-conversion-goal",
		"metric_name":"Placed Order",
		"operator":"equals",
		"value":"true"
	}`))
	require.Equal(t, "set_goal", got.Type)
	require.NotNil(t, got.Goal)
	require.Equal(t, "Placed Order", got.Goal.Field)
}

func TestFlowNode_NotifyTeam_Slack(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"notify-team",
		"url":"https://hooks.slack.com/services/T0/B1/abc",
		"message":"VIP signed up"
	}`))
	require.Equal(t, "webhook_emit", got.Type)
	require.Equal(t, "slack", got.WebhookTarget)
	require.Equal(t, "https://hooks.slack.com/services/T0/B1/abc", got.WebhookURL)
	require.NotNil(t, got.Action)
	require.Equal(t, "webhook_emit", got.Action.Kind)
	require.Equal(t, "slack", got.Action.Metadata["target"])
}

func TestFlowNode_NotifyTeam_Generic(t *testing.T) {
	got := flowNodeFromAction(0, actionFromJSON(t, "A1", `{
		"action_type":"notify-team",
		"url":"https://ops.example.com/alerts",
		"message":"audit"
	}`))
	require.Equal(t, "webhook_emit", got.Type)
	require.Equal(t, "generic", got.WebhookTarget)
}
