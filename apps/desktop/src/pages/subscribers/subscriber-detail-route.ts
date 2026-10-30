import type { DesktopRoute } from "../../lib/desktop-router";

export const SUBSCRIBER_DETAIL_OVERLAY = "subscriber-detail";

export function subscriberDetailRouteId(route: DesktopRoute): string | null {
  if (route.section !== "subscribers") return null;
  if (
    route.overlay?.name === SUBSCRIBER_DETAIL_OVERLAY &&
    route.overlay.resourceId
  ) {
    return route.overlay.resourceId;
  }
  return route.resourceId ?? null;
}

export function routeWithSubscriberDetail(
  route: DesktopRoute,
  subscriberId: string,
): DesktopRoute {
  const next: DesktopRoute = {
    ...(route.section === "subscribers" ? route : { section: "subscribers" }),
    section: "subscribers",
    overlay: {
      name: SUBSCRIBER_DETAIL_OVERLAY,
      resourceId: subscriberId,
    },
  };
  delete next.resourceId;
  return next;
}

export function routeWithoutSubscriberDetail(
  route: DesktopRoute,
): DesktopRoute {
  if (route.section !== "subscribers") return route;
  const next: DesktopRoute = { ...route };
  delete next.resourceId;
  if (next.overlay?.name === SUBSCRIBER_DETAIL_OVERLAY) delete next.overlay;
  return next;
}
