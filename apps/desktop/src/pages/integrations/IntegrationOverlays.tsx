import type { ReactElement } from "react";

import { ConfirmModal } from "../../components/ConfirmModal";
import {
  AnalyticsConnectModal,
  CRMConnectModal,
  LeadConnectModal,
  LoyaltyConnectModal,
  ReviewConnectModal,
  SubscriptionConnectModal,
  SupportConnectModal,
  WarehouseConnectModal,
} from "./NativeProviderConnectModals";
import { DetailPanel, RecipeBlueprintPanel } from "./IntegrationPanels";
import type {
  IntegrationLifecycleController,
  NativeConnectSelection,
} from "./useIntegrationLifecycleController";
import type { IntegrationRecipeController } from "./useIntegrationRecipeController";
import type { IntegrationsCatalogController } from "./useIntegrationsCatalogController";

export function IntegrationOverlays({
  catalog,
  lifecycle,
  recipe,
  canAdmin,
}: {
  catalog: IntegrationsCatalogController;
  lifecycle: IntegrationLifecycleController;
  recipe: IntegrationRecipeController;
  canAdmin: boolean;
}): ReactElement {
  const disconnectItem = lifecycle.pendingDisconnectItem;
  const disconnectConnection = disconnectItem
    ? lifecycle.detail?.item.slug === disconnectItem.slug
      ? lifecycle.detail.connection
      : catalog.connectionMap.get(disconnectItem.slug)
    : undefined;
  const disconnectConnectionCount = Math.max(
    disconnectConnection?.count ?? 0,
    disconnectConnection?.connection_ids?.length ?? 0,
  );
  const ambiguousDisconnect = disconnectConnectionCount > 1;
  return (
    <>
      {lifecycle.selectedSlug ? (
        <DetailPanel
          detail={lifecycle.detail}
          loading={lifecycle.detailLoading}
          categoryLabels={catalog.categoryLabels}
          onClose={lifecycle.closeDetail}
          onOpenPath={(path) =>
            lifecycle.openManage(path, lifecycle.detail?.item)
          }
          onOpenRecipe={(item) => {
            lifecycle.closeDetail();
            void recipe.openRecipeDetail(item);
          }}
          onApplyRecipe={(item) => void recipe.applyRecipe(item)}
          applyingRecipeID={recipe.recipeApplyBusy}
          onLifecycleAction={(item, action) =>
            void lifecycle.runLifecycleAction(item, action)
          }
          busyLifecycleAction={lifecycle.busyLifecycleAction}
          canAdmin={canAdmin}
        />
      ) : null}
      <NativeConnectOverlay
        selection={lifecycle.connectSelection}
        onClose={lifecycle.closeConnect}
        onConnected={lifecycle.completeConnect}
      />
      {recipe.selectedRecipeID ? (
        <RecipeBlueprintPanel
          detail={recipe.recipeDetail}
          fallbackRecipe={recipe.selectedRecipe}
          loading={recipe.recipeDetailLoading}
          applyResult={recipe.recipeApply}
          applyingRecipeID={recipe.recipeApplyBusy}
          onApplyRecipe={(item) => void recipe.applyRecipe(item)}
          onOpenPath={(path) =>
            lifecycle.openManage(
              path,
              recipe.recipeDetail?.source ??
                catalog.catalog?.items.find(
                  (item) => item.slug === recipe.selectedRecipe?.source_slug,
                ),
            )
          }
          onClose={recipe.closeRecipe}
          canAdmin={canAdmin}
        />
      ) : null}
      <ConfirmModal
        open={recipe.pendingRecipe !== null}
        title={`Prepare ${recipe.pendingRecipe?.name ?? "recipe"} setup?`}
        description="Review the access, secrets, and data path before Moosewave prepares the owning setup surface. This step does not create or enable an automation."
        confirmLabel="Prepare setup plan"
        busy={
          recipe.pendingRecipe
            ? recipe.recipeApplyBusy === recipe.pendingRecipe.id
            : false
        }
        onConfirm={recipe.confirmRecipePreparation}
        onClose={recipe.closeRecipePreparation}
      >
        {recipe.pendingRecipe ? (
          <div className="int-recipe-preflight">
            <div className="int-preflight-route" aria-label="Recipe data path">
              <span>{recipe.pendingRecipe.source_slug}</span>
              <span aria-hidden="true">→</span>
              <span>
                {recipe.pendingRecipe.blueprint.destination ||
                  recipe.pendingRecipe.target_slug ||
                  "Moosewave"}
              </span>
            </div>
            <dl>
              <div>
                <dt>Estimated setup</dt>
                <dd>
                  {recipe.pendingRecipe.estimated_minutes > 0
                    ? `${recipe.pendingRecipe.estimated_minutes} minutes`
                    : "Manual review required"}
                </dd>
              </div>
              <div>
                <dt>Scopes</dt>
                <dd>
                  {recipe.pendingRecipe.blueprint.required_scopes?.join(", ") ||
                    "No provider scopes declared"}
                </dd>
              </div>
              <div>
                <dt>Secure references</dt>
                <dd>
                  {recipe.pendingRecipe.blueprint.required_secrets?.join(
                    ", ",
                  ) || "No secret references declared"}
                </dd>
              </div>
              <div>
                <dt>Data handling</dt>
                <dd>
                  {recipe.pendingRecipe.blueprint.data_handling?.join(", ") ||
                    "No special handling declared"}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={disconnectItem !== null}
        title={`Review disconnection for ${disconnectItem?.name ?? "integration"}`}
        description="Moosewave will re-verify the exact target, then either request disconnection through a supported native lifecycle or open the owning management surface. Nothing is treated as complete until connection health and cleanup evidence confirm it."
        confirmLabel="Re-verify and continue"
        danger
        typeToConfirm={disconnectItem?.slug}
        confirmDisabled={ambiguousDisconnect}
        busy={
          lifecycle.disconnectVerifying ||
          (disconnectItem
            ? lifecycle.busyLifecycleAction ===
              `${disconnectItem.slug}:disconnect`
            : false)
        }
        onConfirm={lifecycle.confirmDisconnect}
        onClose={lifecycle.closeDisconnect}
      >
        {disconnectItem ? (
          <div className="int-disconnect-review">
            <dl>
              <div>
                <dt>Integration</dt>
                <dd>{disconnectItem.name}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>
                  {disconnectConnection?.primary_connection_id ??
                    "Will be resolved during re-verification"}
                </dd>
              </div>
              <div>
                <dt>Configured accounts</dt>
                <dd>{disconnectConnectionCount || "Unknown"}</dd>
              </div>
            </dl>
            {ambiguousDisconnect ? (
              <p className="notice notice-danger" role="alert">
                This provider has multiple configured accounts. Open Manage and
                choose one exact account before disconnecting.
              </p>
            ) : (
              <p className="muted">
                New sync work must stop, provider cleanup may continue
                asynchronously, and retained data remains subject to the
                provider-specific retention policy.
              </p>
            )}
          </div>
        ) : null}
      </ConfirmModal>
    </>
  );
}

function NativeConnectOverlay({
  selection,
  onClose,
  onConnected,
}: {
  selection: NativeConnectSelection | null;
  onClose: () => void;
  onConnected: () => Promise<void>;
}): ReactElement | null {
  if (!selection) return null;
  const props = {
    item: selection.item,
    onClose,
    onConnected,
  };
  switch (selection.target) {
    case "crm":
      return <CRMConnectModal {...props} />;
    case "lead_capture":
      return <LeadConnectModal {...props} />;
    case "review_integration":
      return <ReviewConnectModal {...props} />;
    case "loyalty_integration":
      return <LoyaltyConnectModal {...props} />;
    case "subscription_integration":
      return <SubscriptionConnectModal {...props} />;
    case "support_integration":
      return <SupportConnectModal {...props} />;
    case "analytics_integration":
      return <AnalyticsConnectModal {...props} />;
    case "warehouse":
      return <WarehouseConnectModal {...props} />;
  }
}
