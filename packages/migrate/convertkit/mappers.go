// SPDX-License-Identifier: MIT

package convertkit

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/postwave/migrate/canonical"
)

// --- ConvertKit wire types ---

type ckSubscriber struct {
	ID           int                    `json:"id"`
	FirstName    string                 `json:"first_name"`
	EmailAddress string                 `json:"email_address"`
	State        string                 `json:"state"` // active | cancelled | bounced | complained
	CreatedAt    string                 `json:"created_at"`
	Fields       map[string]interface{} `json:"fields"`
	Tags         []ckTag                `json:"tags"` // populated when expanded
}

type ckTag struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

type ckSegment struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
}

type ckSequence struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Hold      bool   `json:"hold"`
	Repeat    bool   `json:"repeat"`
	CreatedAt string `json:"created_at"`
}

type ckSequenceEmail struct {
	ID                int    `json:"id"`
	Subject           string `json:"subject"`
	Content           string `json:"content"`
	SendAtOffsetSecs  int64  `json:"send_at_offset_seconds"`
	PublicationStatus string `json:"publication_status"`
}

type ckBroadcast struct {
	ID          int    `json:"id"`
	Subject     string `json:"subject"`
	Content     string `json:"content"`
	PublishedAt string `json:"published_at"`
	SendAt      string `json:"send_at"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at"`
}

// --- mappers ---

// parseConvertkitTime tolerates the timestamp formats Kit's API ships:
// canonical RFC3339, RFC3339 with sub-second precision, and the legacy
// space-separated SQL-style format some endpoints still emit.
func parseConvertkitTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil && !t.IsZero() {
			return t, true
		}
	}
	return time.Time{}, false
}

// mapSubscriber converts a Kit subscriber to canonical form. Tags are not
// always present on the listing endpoint; the orchestrator can enrich later
// from /tags/{id}/subscriptions.
func mapSubscriber(s ckSubscriber) canonical.Subscriber {
	// Default to disabled on unknown state to avoid leaking unsubscribed
	// users into the "active" bucket on the import side.
	status := canonical.StatusDisabled
	switch s.State {
	case "active":
		status = canonical.StatusEnabled
	case "cancelled", "inactive":
		status = canonical.StatusDisabled
	case "bounced", "complained":
		status = canonical.StatusBlocklisted
	}

	custom := map[string]interface{}{}
	if s.FirstName != "" {
		custom["first_name"] = s.FirstName
	}
	for k, v := range s.Fields {
		custom[k] = v
	}

	tags := make([]string, 0, len(s.Tags))
	for _, t := range s.Tags {
		tags = append(tags, t.Name)
	}

	// Neither the account's default opt-in mode nor a subscriber creation
	// timestamp proves that this subscriber confirmed permission.
	custom["convertkit_created_at"] = s.CreatedAt
	custom["convertkit_state"] = s.State

	return canonical.Subscriber{
		Email:          s.EmailAddress,
		Status:         status,
		ConsentSource:  canonical.ConsentUnknown,
		CustomFields:   custom,
		Tags:           tags,
		SourceID:       strconv.Itoa(s.ID),
		SourcePlatform: canonical.SourceConvertKit,
	}
}

// translateSequence builds an alternating wait→send chain from a Kit sequence.
func translateSequence(s ckSequence, emails []ckSequenceEmail) canonical.Automation {
	out := canonical.Automation{
		Name: s.Name,
		// A source sequence's running/hold state is evidence, not activation
		// authority. Every migrated sequence must be reviewed before Moosewave
		// can activate it.
		Status: "draft",
	}
	out.Triggers = []canonical.AutomationTrigger{{
		Type:      "custom_event",
		EventName: fmt.Sprintf("convertkit_sequence_%d_subscribed", s.ID),
	}}

	prevID := ""
	prevOffset := int64(0)
	for i, e := range emails {
		// Wait = relative offset from previous email.
		duration := e.SendAtOffsetSecs - prevOffset
		if duration < 0 {
			duration = 0
		}
		if duration > 0 || i == 0 {
			waitID := fmt.Sprintf("wait-%d", i)
			out.Nodes = append(out.Nodes, canonical.AutomationNode{
				ID:              waitID,
				Type:            "wait",
				DurationSeconds: duration,
			})
			if prevID != "" {
				out.Edges = append(out.Edges, canonical.AutomationEdge{From: prevID, To: waitID})
			}
			prevID = waitID
		}
		sendID := fmt.Sprintf("send-%d", i)
		out.Nodes = append(out.Nodes, canonical.AutomationNode{
			ID:   sendID,
			Type: "send_email",
			// Kit sequence-email IDs are source identities, not Listmonk
			// template IDs. A destination reference is filled only after a
			// tenant-owned remap has been verified.
			Metadata: map[string]interface{}{
				"source_platform":          string(canonical.SourceConvertKit),
				"source_sequence_id":       strconv.Itoa(s.ID),
				"source_sequence_email_id": strconv.Itoa(e.ID),
				"source_template_id":       strconv.Itoa(e.ID),
			},
		})
		if prevID != "" {
			out.Edges = append(out.Edges, canonical.AutomationEdge{From: prevID, To: sendID})
		}
		prevID = sendID
		prevOffset = e.SendAtOffsetSecs
	}

	if raw, err := json.Marshal(s); err == nil {
		out.SourceDefinition = string(raw)
	}
	return out
}
