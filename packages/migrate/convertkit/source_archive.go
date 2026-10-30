// SPDX-License-Identifier: MIT

package convertkit

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const maxSequenceEvidenceBytes = 64 << 20

// Sequence schedules include provider-specific send days, timezone rules,
// exclusions and publication states. Preserve the original graph inputs and
// HTML for review instead of inventing an equivalent executable workflow.
func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	items, next, err := a.sequenceEvidencePage(ctx, sess, cursor)
	if err != nil {
		return nil, "", err
	}
	if cursor == "" {
		items = append(items,
			parityGap("convertkit:forms", "forms", "Forms and incentive downloads", "Kit forms, embedded signup settings, and incentive downloads need a Moosewave forms rebuild."),
			parityGap("convertkit:landing_pages", "landing_pages", "Landing pages", "Kit landing pages are preserved as a rebuild gap, not imported as editable pages."),
			parityGap("convertkit:commerce", "commerce", "Commerce products and purchases", "Kit commerce products and purchase events require Stripe/Moosewave commerce reconciliation."),
			parityGap("convertkit:visual_automations", "visual_automations", "Visual automations", "Inventory and rebuild visual automation rules and enrollments separately; sequence evidence is not a visual automation graph."),
		)
	}
	return items, next, nil
}

func parityGap(id, resourceType, name, detail string) canonical.SourceArchiveItem {
	return canonical.SourceArchiveItem{SourceID: id, ResourceType: "parity_gap:" + resourceType, Name: name, Status: "manual_review", Payload: map[string]interface{}{"detail": detail, "inventory_detected": false}, SourcePlatform: canonical.SourceConvertKit}
}

func (a *Adapter) sequenceEvidencePage(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	rows, next, err := a.page(ctx, sess, "/sequences", "sequences", cursor)
	if err != nil {
		return nil, "", err
	}
	items := make([]canonical.SourceArchiveItem, 0, len(rows))
	totalBytes := 0
	for _, raw := range rows {
		var sequence struct {
			ID         int    `json:"id"`
			Name       string `json:"name"`
			EmailCount *int   `json:"email_count"`
		}
		if err := json.Unmarshal(raw, &sequence); err != nil {
			return nil, "", err
		}
		if sequence.ID <= 0 || sequence.Name == "" {
			return nil, "", fmt.Errorf("kit: invalid sequence identity")
		}
		payload := map[string]interface{}{}
		if err := json.Unmarshal(raw, &payload); err != nil {
			return nil, "", err
		}
		emails := []map[string]interface{}{}
		totalBytes += len(raw)
		err := a.walk(ctx, sess, fmt.Sprintf("/sequences/%d/emails?include_content=true", sequence.ID), "emails", func(rows []json.RawMessage) error {
			for _, email := range rows {
				totalBytes += len(email)
				if totalBytes > maxSequenceEvidenceBytes {
					return fmt.Errorf("kit: sequence evidence exceeds %d bytes per page", maxSequenceEvidenceBytes)
				}
				var row map[string]interface{}
				if err := json.Unmarshal(email, &row); err != nil {
					return err
				}
				id, _ := row["id"].(float64)
				if id <= 0 {
					return fmt.Errorf("kit: sequence email has no ID")
				}
				if parent, ok := row["sequence_id"].(float64); ok && int(parent) != sequence.ID {
					return fmt.Errorf("kit: sequence email belongs to another sequence")
				}
				emails = append(emails, row)
			}
			return nil
		})
		if err != nil {
			return nil, "", err
		}
		if sequence.EmailCount != nil && *sequence.EmailCount != len(emails) {
			return nil, "", fmt.Errorf("kit: sequence email inventory changed or is incomplete")
		}
		payload["emails"] = emails
		payload["rebuild_required"] = true
		items = append(items, canonical.SourceArchiveItem{
			SourceID:       "convertkit:sequence:" + strconv.Itoa(sequence.ID),
			ResourceType:   "convertkit_sequence_rebuild",
			Name:           sequence.Name,
			Status:         "manual_review",
			Payload:        payload,
			Warnings:       []string{"Rebuild and test sequence schedules, exclusions, email content, and enrollments before activation. A null source content field requires manual content recovery."},
			SourcePlatform: canonical.SourceConvertKit,
		})
	}
	return items, next, nil
}

func (a *Adapter) sequenceEvidence(ctx context.Context, sess adapter.Session) ([]canonical.SourceArchiveItem, error) {
	var all []canonical.SourceArchiveItem
	cursor := ""
	seen := map[string]bool{}
	totalBytes := 0
	for page := 0; page < 10000; page++ {
		items, next, err := a.sequenceEvidencePage(ctx, sess, cursor)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(items)
		if err != nil {
			return nil, err
		}
		totalBytes += len(encoded)
		if totalBytes > maxSequenceEvidenceBytes {
			return nil, fmt.Errorf("kit: sequence review exceeds %d bytes", maxSequenceEvidenceBytes)
		}
		all = append(all, items...)
		if next == "" {
			return all, nil
		}
		if seen[next] {
			return nil, fmt.Errorf("kit: repeated sequence cursor")
		}
		seen[next] = true
		cursor = next
	}
	return nil, fmt.Errorf("kit: sequence review exceeded page limit")
}
