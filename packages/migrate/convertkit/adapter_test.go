// SPDX-License-Identifier: MIT

package convertkit

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/canonical"
)

func TestMapSubscriber_StateMapping(t *testing.T) {
	cases := []struct {
		raw  string
		want canonical.SubscriberStatus
	}{
		{`{"id":1,"email_address":"a@b.com","state":"active","created_at":"2024-04-01T00:00:00Z"}`, canonical.StatusEnabled},
		{`{"id":1,"email_address":"a@b.com","state":"cancelled"}`, canonical.StatusDisabled},
		{`{"id":1,"email_address":"a@b.com","state":"bounced"}`, canonical.StatusBlocklisted},
		{`{"id":1,"email_address":"a@b.com","state":"complained"}`, canonical.StatusBlocklisted},
	}
	for _, tc := range cases {
		var s ckSubscriber
		require.NoError(t, json.Unmarshal([]byte(tc.raw), &s))
		got := mapSubscriber(s)
		require.Equal(t, tc.want, got.Status)
		require.Equal(t, canonical.SourceConvertKit, got.SourcePlatform)
	}
}

func TestMapSubscriber_FieldsAndConsent(t *testing.T) {
	raw := `{"id":42,"first_name":"Ada","email_address":"ada@x.com","state":"active","created_at":"2024-05-10T12:00:00Z","fields":{"company":"Acme","plan":"pro"}}`
	var s ckSubscriber
	require.NoError(t, json.Unmarshal([]byte(raw), &s))
	got := mapSubscriber(s)
	require.Equal(t, "Ada", got.CustomFields["first_name"])
	require.Equal(t, "Acme", got.CustomFields["company"])
	require.Nil(t, got.ConsentTimestamp)
	require.Equal(t, canonical.ConsentUnknown, got.ConsentSource)
	require.Equal(t, s.CreatedAt, got.CustomFields["convertkit_created_at"])
	require.Equal(t, "42", got.SourceID)
}

func TestTranslateSequence_BuildsWaitSendChainFromOffsets(t *testing.T) {
	s := ckSequence{ID: 7, Name: "Onboarding"}
	emails := []ckSequenceEmail{
		{ID: 1, SendAtOffsetSecs: 0},
		{ID: 2, SendAtOffsetSecs: 86400},        // +1 day from previous
		{ID: 3, SendAtOffsetSecs: 86400 + 7200}, // +2h from previous
	}
	got := translateSequence(s, emails)
	require.Equal(t, "draft", got.Status, "source-active sequences must remain review-only after import")
	require.Len(t, got.Triggers, 1)
	require.Equal(t, "custom_event", got.Triggers[0].Type)

	// Expect wait-0(0s), send-0, wait-1(86400), send-1, wait-2(7200), send-2
	types := []string{}
	for _, n := range got.Nodes {
		types = append(types, n.Type)
	}
	require.Equal(t, []string{"wait", "send_email", "wait", "send_email", "wait", "send_email"}, types)
	require.Equal(t, int64(0), got.Nodes[0].DurationSeconds)
	require.Equal(t, int64(86400), got.Nodes[2].DurationSeconds)
	require.Equal(t, int64(7200), got.Nodes[4].DurationSeconds)
	require.Empty(t, got.Nodes[1].TemplateID, "a Kit email ID is not a destination Listmonk template")
	require.Equal(t, "1", got.Nodes[1].Metadata["source_template_id"])
	require.Equal(t, "7", got.Nodes[1].Metadata["source_sequence_id"])
}

func TestTranslateSequence_PausedWhenHold(t *testing.T) {
	got := translateSequence(ckSequence{ID: 1, Name: "x", Hold: true}, nil)
	require.Equal(t, "draft", got.Status, "held sequences also require an explicit destination review")
}

func TestCapabilities_SurfaceLongTailGaps(t *testing.T) {
	caps := New().Capabilities()
	require.True(t, caps.Supports.Subscribers)
	require.True(t, caps.Supports.Segments)
	require.True(t, caps.Supports.Automations)
	require.True(t, caps.Supports.CampaignArchive)
	require.True(t, caps.Supports.PaidSubs)
	require.True(t, caps.Supports.Groups)
	require.True(t, caps.Supports.Campaigns)
	require.True(t, caps.Supports.Reports)
	require.False(t, caps.Supports.Forms)
	require.False(t, caps.Supports.LandingPages)
	require.False(t, caps.Supports.Ecommerce)
}
