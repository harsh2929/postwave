package runtime

import (
	"context"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
)

type tenantContextKey struct{}

func WithTenant(ctx context.Context, tenantID string) context.Context {
	ctx = tenantengine.WithTenant(ctx, tenantID)
	if tenantID == "" {
		return ctx
	}
	return context.WithValue(ctx, tenantContextKey{}, tenantID)
}

func TenantFromContext(ctx context.Context) (string, bool) {
	tenantID, ok := ctx.Value(tenantContextKey{}).(string)
	return tenantID, ok && tenantID != ""
}
