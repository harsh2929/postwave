// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from "next/navigation";

import { ApiError } from "@/lib/api";
import { whoami, type MeResponse } from "@/lib/auth-api";
import { canWriteCampaigns } from "@/lib/campaign-write-authority";

import { TemplateEditorForm } from "../_components/template-editor-form";

export default async function NewTemplatePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = searchParams ? await searchParams : {};
  const mode = Array.isArray(query.mode) ? query.mode[0] : query.mode;
  let me: MeResponse;
  try {
    me = await whoami();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const destination = mode === "import"
        ? "/app/templates/new?mode=import"
        : "/app/templates/new";
      redirect(`/login?next=${encodeURIComponent(destination)}`);
    }
    throw error;
  }

  // The library hides its "Create template" entry points from read-only
  // sessions, but the global Create menu is not role-gated and lands here
  // directly. Without this gate a viewer — or an owner who has toggled viewer
  // mode — authors an entire name/subject/body and learns only from the save
  // rejection that it was never theirs to keep. The sibling edit route already
  // turns read-only visitors back the same way.
  if (!canWriteCampaigns(me)) {
    redirect("/app/templates");
  }

  return (
    <TemplateEditorForm
      key={`${me.tenant_id}:${me.user_id}:new`}
      intent="create"
      initialSurface={mode === "import" ? "code" : "design"}
      recoveryScope={{ tenantId: me.tenant_id, userId: me.user_id }}
    />
  );
}
