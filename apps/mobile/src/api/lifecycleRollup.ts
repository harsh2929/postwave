/**
 * api/lifecycleRollup.ts — transport for the lifecycle-stage rollup.
 *
 *   GET /api/v1/lifecycle/distribution   viewer / read:reports
 *   GET /api/v1/lifecycle/stages         viewer / read:subscribers
 *
 * Parsing lives in `lib/lifecycleDistribution.ts` (react-native-free); this
 * file is only the two calls. UNWRAP BEFORE PARSING: `rawRequest` resolves
 * to the `{data, error}` ENVELOPE (api/request.ts), never the body — handing
 * the envelope to a parser that reads `.items` returns `[]` for every
 * well-formed response, which renders as a permanently empty card that is
 * indistinguishable from a workspace with no subscribers.
 */
import { ApiRequestError } from "@/api/apiRequestError";
import { rawRequest, type AIApiError } from "@/api/request";
import {
  parseLifecycleDistribution,
  parseLifecycleStages,
  type LifecycleDistributionRow,
} from "@/lib/lifecycleDistribution";

export class LifecycleReadError extends ApiRequestError {
  constructor(error: AIApiError, fallback: string) {
    super(error, fallback);
    this.name = "LifecycleReadError";
  }
}

/**
 * True when the deployment simply has no lifecycle routes mounted — the
 * card hides rather than nags, same call desktop makes on its 404 branch.
 */
export function isLifecycleUnavailable(err: unknown): boolean {
  return err instanceof LifecycleReadError && err.status === 404;
}

export async function fetchLifecycleDistribution(): Promise<
  LifecycleDistributionRow[]
> {
  const res = await rawRequest<unknown>(
    "GET",
    "/api/v1/lifecycle/distribution",
  );
  if (res.error) {
    throw new LifecycleReadError(
      res.error,
      "Couldn't load the lifecycle rollup.",
    );
  }
  return parseLifecycleDistribution(res.data);
}

export async function fetchLifecycleStages(): Promise<string[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/lifecycle/stages");
  if (res.error) {
    throw new LifecycleReadError(
      res.error,
      "Couldn't load the stage catalog.",
    );
  }
  return parseLifecycleStages(res.data);
}
