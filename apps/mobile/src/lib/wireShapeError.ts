// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A 2xx response whose body this client cannot read.
 *
 * `code` is what lib/errorCopy reads to tell this apart from a network blip,
 * so a parser that refuses a body throws this rather than a bare Error.
 * `message` keeps a parser's own sentence where it already had one; the
 * generic sentence is the default.
 */
export class WireShapeError extends Error {
  readonly code = "wire_shape";

  constructor(resource: string, message?: string) {
    super(message ?? `The server sent an unexpected ${resource} response.`);
    this.name = "WireShapeError";
  }
}
