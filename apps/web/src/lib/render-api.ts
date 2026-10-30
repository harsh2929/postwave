// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed wrapper around the gateway's `/api/v1/render` endpoint.
// Mirrors the pattern in `inbox-reality-api.ts`: real call by default, mocks
// only when explicit mock mode is enabled.

import { api } from "./api";
import { isMockModeEnabled } from "./mock-mode";
import type { RenderEnvironment, RenderResponse } from "./render-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./render-mocks");

interface RenderRequestBody {
  html: string;
  environments?: RenderEnvironment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Fail closed when the render proxy returns a partial success envelope. */
export function normalizeRenderResponse(raw: unknown): RenderResponse {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.renders) ||
    typeof raw.cache_hit !== "boolean"
  ) {
    throw new Error("Cross-client preview response was malformed.");
  }
  const names = new Set<string>();
  const renders = raw.renders.map((value, index) => {
    if (!isRecord(value) || !isRecord(value.environment)) {
      throw new Error(`Cross-client preview ${index + 1} was malformed.`);
    }
    const environment = value.environment;
    const validPositiveInteger = (candidate: unknown): candidate is number =>
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate > 0;
    if (
      typeof environment.name !== "string" ||
      !environment.name.trim() ||
      names.has(environment.name) ||
      !validPositiveInteger(environment.viewport_width) ||
      !validPositiveInteger(environment.viewport_height) ||
      typeof environment.user_agent !== "string" ||
      typeof environment.dark_mode !== "boolean" ||
      typeof value.image_url !== "string" ||
      !validPositiveInteger(value.width) ||
      !validPositiveInteger(value.height) ||
      !Array.isArray(value.issues) ||
      !value.issues.every((issue) => typeof issue === "string")
    ) {
      throw new Error(`Cross-client preview ${index + 1} was malformed.`);
    }
    names.add(environment.name);
    return {
      environment: {
        name: environment.name,
        viewport_width: environment.viewport_width,
        viewport_height: environment.viewport_height,
        user_agent: environment.user_agent,
        dark_mode: environment.dark_mode,
      },
      image_url: value.image_url,
      width: value.width,
      height: value.height,
      issues: value.issues,
    };
  });
  if (
    raw.render_mode !== undefined &&
    raw.render_mode !== "simulation" &&
    raw.render_mode !== "placeholder" &&
    raw.render_mode !== "unverified"
  ) {
    throw new Error("Cross-client preview provenance was malformed.");
  }
  return {
    renders,
    cache_hit: raw.cache_hit,
    ...(raw.render_mode ? { render_mode: raw.render_mode } : {}),
  };
}

export async function renderEmail(
  html: string,
  environments?: RenderEnvironment[],
  signal?: AbortSignal,
): Promise<RenderResponse> {
  if (USE_MOCKS) {
    return normalizeRenderResponse(
      (await loadMocks()).mockRenderResponse(html),
    );
  }
  const body: RenderRequestBody = { html };
  if (environments && environments.length > 0) body.environments = environments;
  return api
    .post<unknown>("/api/v1/render", body, { signal, requireOnline: true })
    .then(normalizeRenderResponse);
}
