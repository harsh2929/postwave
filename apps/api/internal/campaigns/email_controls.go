package campaigns

import (
	"context"
	"strings"
)

func (d *Deps) emailSendingPaused(ctx context.Context, tenantID string) (bool, string, error) {
	if d == nil || d.EmailControls == nil {
		return false, "", nil
	}
	paused, reason, err := d.EmailControls.EmailSendingPaused(ctx, tenantID)
	return paused, strings.TrimSpace(reason), err
}
