import type { ReactElement } from "react";

import {
  AuditAccessRequestsAdminPanel,
  AuditBlockedAccess,
} from "./AuditAccessPanels";
import { AuditFilterPanels } from "./AuditFilterPanels";
import {
  AuditPageHeader,
  AuditReleaseHolds,
  AuditVisibilityBanner,
} from "./AuditPageHeader";
import { AuditPageOverlays } from "./AuditPageOverlays";
import { AuditPageViews } from "./AuditPageViews";
import {
  AuditViewModeToolbar,
  AuditViewReleaseHold,
} from "./AuditViewControls";
import type { AuditPageController } from "./useAuditPageController";

function AuditHardError({
  retrying,
  onRetry,
}: {
  retrying: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <section
      className="audit-hard-error"
      aria-labelledby="audit-hard-error-title"
      role="alert"
      data-testid="audit-hard-error"
    >
      <div>
        <span className="audit-section-kicker">Evidence unavailable</span>
        <h2 id="audit-hard-error-title">
          The event window couldn&apos;t be verified
        </h2>
        <p>
          The first audit request did not return a trustworthy result. Moosewave
          has not interpreted that failure as an empty log.
        </p>
      </div>
      <button
        type="button"
        className="btn"
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? "Retrying…" : "Try again"}
      </button>
    </section>
  );
}

export function AuditPagePresentation({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  if (controller.blocked) {
    return (
      <AuditBlockedAccess
        error={controller.scopes.error}
        onRetry={controller.retryAccess}
      />
    );
  }
  const viewMode = controller.filters.viewMode;
  const hardError = controller.data.phase === "hard-error";
  return (
    <div className="audit-workspace" data-testid="audit-workspace">
      <AuditPageHeader controller={controller} />
      <AuditVisibilityBanner controller={controller} />
      <AuditFilterPanels controller={controller} />
      <AuditViewModeToolbar
        viewMode={viewMode}
        onChange={controller.filters.setViewMode}
      />
      {hardError ? (
        <AuditHardError
          retrying={controller.data.loading || controller.data.refreshing}
          onRetry={() => void controller.data.load()}
        />
      ) : viewMode === "list" ? (
        <AuditPageViews controller={controller} />
      ) : (
        <AuditViewReleaseHold
          viewMode={viewMode}
          onUseList={() => controller.filters.setViewMode("list")}
        />
      )}
      <AuditReleaseHolds />
      {controller.scopes.isAdmin ? <AuditAccessRequestsAdminPanel /> : null}
      <AuditPageOverlays controller={controller} />
    </div>
  );
}
