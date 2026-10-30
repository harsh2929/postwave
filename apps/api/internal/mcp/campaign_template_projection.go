// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
)

// projectNativeCampaignTemplateResponse is the native-MCP trust boundary for
// repository-backed campaign-template values. Repositories return internal
// records; every shape that can contain a Template must receive the same
// request-aware projection as HTTP before the MCP result is serialized.
func projectNativeCampaignTemplateResponse(ctx context.Context, result any) any {
	switch typed := result.(type) {
	case *campaigntemplates.Template:
		campaigntemplates.ProjectTemplateForRequest(ctx, typed)
	case *campaigntemplates.SearchResponse:
		if typed != nil {
			campaigntemplates.ProjectTemplatesForRequest(ctx, typed.Items)
		}
	case *campaigntemplates.TemplateRevision:
		if typed != nil {
			campaigntemplates.ProjectTemplateForRequest(ctx, &typed.Snapshot)
		}
	case *campaigntemplates.RecentTemplateView:
		if typed != nil {
			campaigntemplates.ProjectTemplateForRequest(ctx, &typed.Template)
		}
	case []campaigntemplates.RecentTemplateView:
		for index := range typed {
			campaigntemplates.ProjectTemplateForRequest(
				ctx,
				&typed[index].Template,
			)
		}
	case *campaigntemplates.CampaignTemplateCollection:
		projectNativeCampaignTemplateCollection(ctx, typed)
	case []campaigntemplates.CampaignTemplateCollection:
		for index := range typed {
			projectNativeCampaignTemplateCollection(ctx, &typed[index])
		}
	case *campaigntemplates.CompareTemplatesResponse:
		if typed != nil {
			for index := range typed.Items {
				campaigntemplates.ProjectTemplateForRequest(
					ctx,
					&typed.Items[index].Template,
				)
			}
		}
	}
	return result
}

func projectNativeCampaignTemplateCollection(
	ctx context.Context,
	collection *campaigntemplates.CampaignTemplateCollection,
) {
	if collection == nil {
		return
	}
	campaigntemplates.ProjectTemplatesForRequest(ctx, collection.Items)
}
