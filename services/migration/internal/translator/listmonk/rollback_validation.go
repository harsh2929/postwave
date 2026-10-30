package listmonk

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// ListRollbackNeedsDeletion verifies that a tracked create-only list is still
// exactly the migration-owned object. A 404 is the intended terminal state of
// a prior partial rollback and therefore needs no second DELETE.
func (c *Client) ListRollbackNeedsDeletion(ctx context.Context, resource ImportedResource) (bool, error) {
	id, err := strconv.Atoi(resource.DestinationID)
	if err != nil || id <= 0 {
		return false, fmt.Errorf("list rollback ledger %s has invalid destination id %q", resource.ID, resource.DestinationID)
	}
	current, err := c.GetList(ctx, id)
	if err != nil {
		if listmonkNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("%w: Listmonk list %d lookup: %v", ErrRollbackConflict, id, err)
	}
	name := metadataString(resource.DestinationMetadata, "name")
	fingerprint := metadataString(resource.DestinationMetadata, "ownership_fingerprint")
	wantFingerprint := migrationOwnershipFingerprint("list", resource.TenantID, resource.JobID, string(resource.SourcePlatform), resource.SourceID, name)
	wantScopedName := migrationScopedSourceName(name, resource.JobID, resource.SourceID)
	wantDescription := fmt.Sprintf("Moosewave migration-owned audience; tenant=%s; job=%s; source=%s; source_id=%s; fingerprint=%s; activation requires Moosewave review",
		resource.TenantID, resource.JobID, resource.SourcePlatform, resource.SourceID, fingerprint)
	wantTags := []string{"postwave-migration", "tenant:" + resource.TenantID, "postwave-fingerprint:" + fingerprint}
	if fingerprint == "" || fingerprint != wantFingerprint || current.ID != id || current.Name != wantScopedName ||
		current.Type != "private" || current.Optin != "single" || current.Description != wantDescription ||
		!sameFoldedStringSet(current.Tags, wantTags) {
		return false, fmt.Errorf("%w: Listmonk list %d no longer matches its exact migration ownership/state fingerprint", ErrRollbackConflict, id)
	}
	return true, nil
}

// TemplateRollbackNeedsDeletion is the template counterpart to
// ListRollbackNeedsDeletion. Recomputing the fingerprint from the current body
// catches user edits even when the HTML marker itself was left in place.
func (c *Client) TemplateRollbackNeedsDeletion(ctx context.Context, resource ImportedResource) (bool, error) {
	id, err := strconv.Atoi(resource.DestinationID)
	if err != nil || id <= 0 {
		return false, fmt.Errorf("template rollback ledger %s has invalid destination id %q", resource.ID, resource.DestinationID)
	}
	current, err := c.GetTemplate(ctx, id)
	if err != nil {
		if listmonkNotFound(err) {
			return false, nil
		}
		return false, fmt.Errorf("%w: Listmonk template %d lookup: %v", ErrRollbackConflict, id, err)
	}
	name := metadataString(resource.DestinationMetadata, "name")
	fingerprint := metadataString(resource.DestinationMetadata, "ownership_fingerprint")
	marker := fmt.Sprintf("<!-- postwave-migration-fingerprint:%s -->\n", fingerprint)
	body, marked := strings.CutPrefix(current.Body, marker)
	wantFingerprint := migrationOwnershipFingerprint("template", resource.TenantID, resource.JobID, string(resource.SourcePlatform), resource.SourceID, name, body)
	wantScopedName := migrationScopedSourceName(name, resource.JobID, resource.SourceID)
	if fingerprint == "" || !marked || fingerprint != wantFingerprint || current.ID != id || current.Name != wantScopedName || current.Type != "campaign" {
		return false, fmt.Errorf("%w: Listmonk template %d no longer matches its exact migration ownership/content fingerprint", ErrRollbackConflict, id)
	}
	return true, nil
}

func listmonkNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), " status 404:")
}

func sameFoldedStringSet(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	remaining := make(map[string]int, len(right))
	for _, value := range right {
		remaining[strings.ToLower(strings.TrimSpace(value))]++
	}
	for _, value := range left {
		key := strings.ToLower(strings.TrimSpace(value))
		if remaining[key] == 0 {
			return false
		}
		remaining[key]--
	}
	return true
}
