package handlers

import (
	"context"
	"fmt"

	"github.com/postwave/migrate/canonical"
	"github.com/postwave/postwave/services/migration/internal/jobstore"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

const destinationIDCursorKey = "destination_instance_id"
const destinationHashCursorKey = "destination_endpoint_hash"

// bindJobDestination is called before the initial commit transition is saved.
// Subsequent workers, source-event replay and rollback only verify this pair.
func bindJobDestination(job *canonical.MigrationJob, client *listmonkx.Client) error {
	if client == nil {
		return fmt.Errorf("destination is unavailable")
	}
	if err := client.ValidateMigrationIsolation(job.TenantID); err != nil {
		return err
	}
	if _, ok := cursorString(job.Cursor, destinationIDCursorKey); ok {
		return verifyJobDestination(job, client)
	}
	if client.DestinationID == "" {
		return nil
	} // explicitly configured legacy dedicated engine
	if job.Cursor == nil {
		job.Cursor = map[string]*string{}
	}
	id, hash := client.DestinationID, client.EndpointHash
	job.Cursor[destinationIDCursorKey], job.Cursor[destinationHashCursorKey] = &id, &hash
	return nil
}

func verifyJobDestination(job *canonical.MigrationJob, client *listmonkx.Client) error {
	id, hasID := cursorString(job.Cursor, destinationIDCursorKey)
	hash, hasHash := cursorString(job.Cursor, destinationHashCursorKey)
	if !hasID && !hasHash && client.DestinationID == "" {
		return nil
	}
	if !hasID || !hasHash || id != client.DestinationID || hash != client.EndpointHash || client.DedicatedTenantID != job.TenantID {
		return fmt.Errorf("migration destination binding does not match this workspace's configured engine; restore the original destination before continuing")
	}
	return nil
}

func (h *Migration) listmonkClientForJob(ctx context.Context, job *canonical.MigrationJob) (*listmonkx.Client, error) {
	client, err := h.listmonkClient(jobstore.WithTenantID(ctx, job.TenantID))
	if err != nil {
		return nil, err
	}
	if err := verifyJobDestination(job, client); err != nil {
		return nil, err
	}
	return client, nil
}
