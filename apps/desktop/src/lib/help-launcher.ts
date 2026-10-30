/** Shell-owned, privacy-bounded state for contextual help and support. */

import { useSyncExternalStore } from "react";

import {
  type ContextualHelpRequest,
  sanitizeContextualHelpRequest,
} from "./contextual-help";
import { getDesktopRoute } from "./desktop-router";
import type { Section } from "./store";

export interface HelpLauncherState {
  open: boolean;
  request: ContextualHelpRequest;
  destination: Section | null;
  revision: number;
}

const subscribers = new Set<() => void>();
let state: HelpLauncherState = {
  open: false,
  request: {},
  destination: null,
  revision: 0,
};

function emit(): void {
  for (const subscriber of subscribers) subscriber();
}

function setState(
  open: boolean,
  request: ContextualHelpRequest = state.request,
  destination: Section | null = state.destination,
): void {
  state = { open, request, destination, revision: state.revision + 1 };
  emit();
}

export function requestHelpLauncherToggle(): void {
  const open = !state.open;
  setState(open, {}, open ? currentSection() : null);
}

export function requestContextualHelpOpen(
  request: ContextualHelpRequest = {},
): void {
  setState(true, sanitizeContextualHelpRequest(request), currentSection());
}

export function closeHelpLauncher(): void {
  if (!state.open && Object.keys(state.request).length === 0) return;
  setState(false, {}, null);
}

export function getHelpLauncherState(): HelpLauncherState {
  return state;
}

export function subscribeHelpLauncherToggle(
  subscriber: () => void,
): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function useHelpLauncherState(): HelpLauncherState {
  return useSyncExternalStore(
    subscribeHelpLauncherToggle,
    getHelpLauncherState,
    getHelpLauncherState,
  );
}

function currentSection(): Section {
  return getDesktopRoute().section;
}

/** @internal Test reset. */
export function resetHelpLauncherForTests(): void {
  state = { open: false, request: {}, destination: null, revision: 0 };
  emit();
}
