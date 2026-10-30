// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from "next/navigation";

import {
  campaignTemplateCapabilities,
  getCampaignTemplate,
  isOwnedCampaignTemplate,
} from "@/lib/campaign-templates-api";
import { handleCampaignTemplateRouteError } from "@/lib/campaign-template-route-error";
import { whoami } from "@/lib/auth-api";

import { TemplateEditorForm } from "../../_components/template-editor-form";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditTemplatePage({ params }: PageProps) {
  const { id } = await params;
  let template;
  let me;
  try {
    [template, me] = await Promise.all([getCampaignTemplate(id), whoami()]);
  } catch (error) {
    handleCampaignTemplateRouteError(error, `/app/templates/${id}/edit`);
  }

  // Only workspace-owned templates are editable; the tenant-scoped backend
  // won't mutate platform/reference catalog rows, so send read-only ones back
  // to their detail page rather than showing an editor that would 404 on save.
  if (
    !isOwnedCampaignTemplate(template) ||
    !campaignTemplateCapabilities(template).can_edit_directly
  ) {
    redirect(`/app/templates/${id}`);
  }

  return (
    <TemplateEditorForm
      key={`${me.tenant_id}:${me.user_id}:${template.id}:${template.etag}`}
      intent="edit"
      template={template}
      recoveryScope={{ tenantId: me.tenant_id, userId: me.user_id }}
    />
  );
}
