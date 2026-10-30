// SPDX-License-Identifier: AGPL-3.0-only
import type { Route } from "next";

export function asRoute<T extends string>(href: T): Route<T> {
  return href as Route<T>;
}
