package campaigns

import (
	"context"
	"errors"
	"net/http"

	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

func (d *Deps) checkLiveDispatch(ctx context.Context, tenantID string) error {
	if d == nil {
		return dispatchcontrol.ErrLiveDispatchDisabled
	}
	return dispatchcontrol.Check(d.LiveDispatch, ctx, tenantID)
}

func liveDispatchQueueError(err error) *queueError {
	status, code, message := dispatchcontrol.HTTPError(err)
	return &queueError{Status: status, Code: code, Message: message}
}

func (d *Deps) authorizeQueueDispatch(ctx context.Context, tenantID string, sandbox bool) *queueError {
	if sandbox {
		if d == nil || d.Sandbox == nil {
			return &queueError{Status: http.StatusServiceUnavailable, Code: "sandbox_unavailable",
				Message: "sandbox lifecycle simulator is not configured"}
		}
		return nil
	}
	if err := d.checkLiveDispatch(ctx, tenantID); err != nil {
		return liveDispatchQueueError(err)
	}
	return nil
}

func writeLiveDispatchError(w http.ResponseWriter, err error) {
	dispatchcontrol.WriteHTTPError(w, err)
}

func (d *Deps) checkScheduledMaterialization() error {
	runtimeEnabled := d != nil && d.ScheduledMaterializationEnabled
	return campaigndispatch.CheckScheduledMaterialization(runtimeEnabled)
}

func writeScheduledMaterializationError(w http.ResponseWriter, err error) {
	status := http.StatusServiceUnavailable
	if errors.Is(err, campaigndispatch.ErrSchedulingDisabled) {
		status = http.StatusLocked
	}
	code, message := campaigndispatch.PublicError(err)
	writeJSON(w, status, errEnv(code, message))
}
