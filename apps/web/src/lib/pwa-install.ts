// SPDX-License-Identifier: AGPL-3.0-only

export const PWA_INSTALL_TRIGGER_EVENTS = [
  "postwave:campaign-sent",
  "postwave:subscriber-added",
  "postwave:template-saved",
] as const;

export type PwaInstallTriggerEvent =
  (typeof PWA_INSTALL_TRIGGER_EVENTS)[number];

export function dispatchPwaInstallTrigger(event: PwaInstallTriggerEvent): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(event));
}

