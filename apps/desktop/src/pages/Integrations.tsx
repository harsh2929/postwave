import type { ReactElement } from "react";

import { useCanAdmin } from "../lib/store";
import {
  IntegrationsBody,
  IntegrationsHeaderControls,
} from "./integrations/IntegrationsCatalogSurface";
import { IntegrationOverlays } from "./integrations/IntegrationOverlays";
import { useIntegrationLifecycleController } from "./integrations/useIntegrationLifecycleController";
import { useIntegrationRecipeController } from "./integrations/useIntegrationRecipeController";
import { useIntegrationsCatalogController } from "./integrations/useIntegrationsCatalogController";

import "../styles-integrations.css";
import "../styles-integrations-reports.css";
import "../styles-integrations-detail.css";

export function Integrations(): ReactElement {
  const canAdmin = useCanAdmin();
  const catalog = useIntegrationsCatalogController();
  const lifecycle = useIntegrationLifecycleController({
    canAdmin,
    catalog: catalog.catalog,
    connectionMap: catalog.connectionMap,
    refresh: catalog.refresh,
  });
  const recipe = useIntegrationRecipeController({
    canAdmin,
    recipes: catalog.recipes,
    detail: lifecycle.detail,
  });

  return (
    <div
      className="page integrations-page"
      aria-busy={catalog.loading ? "true" : undefined}
    >
      <IntegrationsHeaderControls state={catalog} />
      <IntegrationOverlays
        catalog={catalog}
        lifecycle={lifecycle}
        recipe={recipe}
        canAdmin={canAdmin}
      />
      <IntegrationsBody
        state={catalog}
        lifecycle={lifecycle}
        recipe={recipe}
        canAdmin={canAdmin}
      />
    </div>
  );
}
