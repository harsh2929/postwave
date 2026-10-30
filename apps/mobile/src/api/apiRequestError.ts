// SPDX-License-Identifier: AGPL-3.0-only
/**
 * api/apiRequestError.ts — the one thrown form of an AIApiError.
 *
 * checkedApiResult and every api module's own error class used to copy the
 * envelope fields onto an Error by hand, each keeping a different subset. The
 * copy that bit was VendorVerifyError: it kept status and code and dropped
 * `denial`, so the 402 "no provider credits" plan refusal on a PAID write
 * read as "Something went wrong loading this. Please try again." Extending
 * this class keeps every field checkedApiResult keeps, by the same rules.
 *
 * WHY THIS FILE AND NOT request.ts. Over a hundred test files mock
 * `./request` / `@/api/request`, many with a bare factory. A base class
 * exported from there is `undefined` under such a mock, and
 * `class X extends undefined` throws at import. The AIApiError import below is
 * type-only and erased, so no request mock can reach this module.
 *
 * WHY THE OPTIONAL FIELDS ARE AN INTERFACE. The two toolchains disagree about
 * class fields. Under vitest (esbuild, ES2022 define semantics) a declared
 * field becomes an own `undefined` key, and a subclass that re-declares a base
 * field resets it to undefined AFTER super() runs. The app's Babel strips
 * type-only fields and rejects `declare`. So the optional fields live on a
 * merged interface and are assigned only when present, and subclasses never
 * re-declare them (apiRequestError.consistency.test.ts enforces that).
 */
import type { PostwaveResponseMetadata } from "@postwave/sdk";

import type { ApiDenial } from "@/lib/denialEnvelope";

import type { AIApiError } from "./request";

export interface ApiRequestError {
  readonly requestId?: string;
  code?: string;
  /** The server's classified refusal (apps/api/internal/entitlement). */
  denial?: ApiDenial;
  /** The runtimecapability envelope: a 503 that is a product boundary. */
  capability?: string;
  runtimeStatus?: string;
  retryable?: boolean;
  fields?: { path: string; message: string }[];
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
  responseMetadata?: PostwaveResponseMetadata;
}

/**
 * `name` is left as "Error" here, so checkedApiResult's rejections read the
 * same in Sentry as before. Subclasses set their own.
 */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(error: AIApiError, fallback = "") {
    super(error.message || fallback);
    this.status = error.status;
    Object.assign(this, envelopeFields(error));
  }
}

/**
 * The fields a rejection carries, each only when present. An explicit
 * `undefined` would read as "this envelope declared the field" to any `in` /
 * hasOwnProperty check downstream. `payload`, `region` and `correctEndpoint`
 * stay on the result envelope only, as they always have.
 */
type EnvelopeFields = {
  -readonly [K in keyof ApiRequestError]?: ApiRequestError[K];
};

function envelopeFields(error: AIApiError): EnvelopeFields {
  const out: EnvelopeFields = {};
  // A mutation's onError is where a per-field message or a wait time is most
  // useful; losing them here would undo the boundary fix for writes.
  if (error.fields) out.fields = error.fields;
  if (error.retryAfterSeconds !== undefined) {
    out.retryAfterSeconds = error.retryAfterSeconds;
  }
  if (error.details) out.details = error.details;
  if (error.responseMetadata) out.responseMetadata = error.responseMetadata;
  if (error.requestId) out.requestId = error.requestId;
  // The discriminator the envelope carries; without it a mutation that goes
  // through checkedApiResult sees only the status again.
  if (error.code) out.code = error.code;
  // "Ask an editor" vs "upgrade" vs "wait 2 minutes" are different next steps
  // for someone who just tried to send something.
  if (error.denial) out.denial = error.denial;
  // A write rejected by a deliberately disabled runtime must still be
  // recognisable as one. `runtimeStatus` and `retryable` are read ONLY inside
  // this envelope: outside it, `retryable` is not a contract checkedApiResult
  // ever carried.
  if (error.capability) {
    out.capability = error.capability;
    if (error.runtimeStatus !== undefined) {
      out.runtimeStatus = error.runtimeStatus;
    }
    if (error.retryable !== undefined) out.retryable = error.retryable;
  }
  return out;
}
