// SPDX-License-Identifier: MIT

package mailchimp

// Node-translation tests for the expanded Mailchimp customer-journey action
// coverage. Complements adapter_test.go and e2e_test.go which already cover
// the legacy classic-automation translator end-to-end.

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func journeyNodeFromJSON(t *testing.T, raw string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(raw), &m))
	return m
}

func TestJourneyNode_MergeFieldUpdate(t *testing.T) {
	got := journeyNodeFromMap(0, journeyNodeFromJSON(t, `{
		"id":"n1",
		"type":"merge_field_update",
		"merge_field":"FNAME",
		"value":"Ada"
	}`))
	require.Equal(t, "update_subscriber", got.Type)
	require.NotNil(t, got.Action)
	require.Equal(t, "update_subscriber", got.Action.Kind)
	require.Equal(t, "Ada", got.Action.Properties["FNAME"])
	require.NotEmpty(t, got.RawSource, "raw_source must preserve the original Mailchimp payload")
	require.Equal(t, "merge_field_update", got.RawSource["type"])
}

func TestJourneyNode_MergeFieldUpdate_UpdatesList(t *testing.T) {
	got := journeyNodeFromMap(0, journeyNodeFromJSON(t, `{
		"id":"n1",
		"type":"merge_field_update",
		"updates":[
			{"merge_field":"fname","value":"Ada"},
			{"tag":"PLAN","value":"pro"}
		]
	}`))
	require.Equal(t, "update_subscriber", got.Type)
	require.Equal(t, "Ada", got.Action.Properties["FNAME"])
	require.Equal(t, "pro", got.Action.Properties["PLAN"])
}

func TestJourneyNode_MoveToList(t *testing.T) {
	got := journeyNodeFromMap(0, journeyNodeFromJSON(t, `{
		"id":"n1",
		"type":"move_to_list",
		"target_list_id":"audience-7"
	}`))
	require.Equal(t, "list_membership", got.Type)
	require.NotNil(t, got.Action)
	require.Equal(t, "move_to_list", got.Action.Kind)
	require.Equal(t, "audience-7", got.Action.ListID)
}

func TestJourneyNode_SendPostcard(t *testing.T) {
	got := journeyNodeFromMap(0, journeyNodeFromJSON(t, `{
		"id":"n1",
		"type":"send_postcard",
		"postcard_id":"pc_42",
		"front_image":"https://files.example.com/front.png",
		"message":"Welcome to Moosewave"
	}`))
	require.Equal(t, "send_postcard", got.Type)
	require.NotNil(t, got.Action)
	require.Equal(t, "physical_mail", got.Action.Kind)
	require.Equal(t, "Welcome to Moosewave", got.Action.Message)
	require.Equal(t, "physical_mail", got.Action.Metadata["channel"])
	require.Equal(t, "pc_42", got.Action.Metadata["postcard_id"])
}

func TestJourneyNode_WaitForAction(t *testing.T) {
	got := journeyNodeFromMap(0, journeyNodeFromJSON(t, `{
		"id":"n1",
		"type":"wait_for_action",
		"amount":3,
		"unit":"day",
		"field":"PLAN",
		"op":"equals",
		"value":"pro"
	}`))
	require.Equal(t, "wait_for_condition", got.Type)
	require.EqualValues(t, 3*86400, got.TimeoutSeconds)
	require.NotNil(t, got.Condition)
	require.Equal(t, "PLAN", got.Condition.Field)
	require.Equal(t, "equals", got.Condition.Comparator)
}
