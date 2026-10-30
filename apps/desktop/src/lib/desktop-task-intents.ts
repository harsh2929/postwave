import {
  getDesktopRoute,
  replaceDesktopRouteAfterExplicitOverlayClose,
  type DesktopRoute,
} from "./desktop-router";

export const DESKTOP_TASK_INTENTS = {
  "new-campaign": {
    section: "campaigns",
    overlay: "create",
    label: "New campaign",
    hint: "Draft → Subject → Send",
  },
  "new-form": {
    section: "forms",
    overlay: "create",
    label: "New form",
    hint: "Create a signup form",
  },
  "new-list": {
    section: "lists",
    overlay: "create",
    label: "New list",
    hint: "Group of subscribers",
  },
  "new-template": {
    section: "templates",
    overlay: "create",
    label: "New template",
    hint: "Reusable email body",
  },
  "import-subscribers": {
    section: "subscribers",
    overlay: "import",
    label: "Import subscribers",
    hint: "CSV upload + mapping",
  },
} as const;

export type DesktopTaskIntent = keyof typeof DESKTOP_TASK_INTENTS;

export const DESKTOP_TASK_COMMANDS = Object.entries(DESKTOP_TASK_INTENTS).map(
  ([intent, definition]) => ({
    intent: intent as DesktopTaskIntent,
    label: definition.label,
    hint: definition.hint,
  }),
);

/** A bounded, credential-free route for a user-visible desktop task. */
export function desktopTaskIntentRoute(intent: DesktopTaskIntent): DesktopRoute {
  const definition = DESKTOP_TASK_INTENTS[intent];
  return {
    section: definition.section,
    overlay: { name: definition.overlay },
  };
}

/**
 * Parse only the exact task routes this module creates. Extra record, query,
 * filter, sort, tab, Settings, or overlay-id state is rejected so task URLs
 * can never become an accidental carrier for a draft or credential.
 */
export function desktopTaskIntentFromRoute(
  route: DesktopRoute,
): DesktopTaskIntent | null {
  if (
    route.resourceId !== undefined ||
    route.tab !== undefined ||
    route.query !== undefined ||
    route.sort !== undefined ||
    route.filters !== undefined ||
    route.settingsAnchor !== undefined ||
    route.overlay?.resourceId !== undefined
  ) {
    return null;
  }
  for (const intent of Object.keys(DESKTOP_TASK_INTENTS) as DesktopTaskIntent[]) {
    const definition = DESKTOP_TASK_INTENTS[intent];
    if (
      route.section === definition.section &&
      route.overlay?.name === definition.overlay
    ) {
      return intent;
    }
  }
  return null;
}

/**
 * Consume a routed task only after its owner has explicitly closed or
 * completed it. The narrow router primitive bypasses lifecycle review because
 * the owner has already handled its draft/operation before calling here.
 */
export function consumeDesktopTaskIntent(intent: DesktopTaskIntent): boolean {
  if (desktopTaskIntentFromRoute(getDesktopRoute()) !== intent) return false;
  const definition = DESKTOP_TASK_INTENTS[intent];
  return replaceDesktopRouteAfterExplicitOverlayClose(
    definition.section,
    definition.overlay,
  );
}
