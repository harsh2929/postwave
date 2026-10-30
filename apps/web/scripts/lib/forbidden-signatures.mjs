// SPDX-License-Identifier: AGPL-3.0-only

function validatedSignatures(signatures) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new Error("forbidden signature contract is empty");
  }
  return signatures.map((signature, index) => {
    if (
      !signature ||
      typeof signature.name !== "string" ||
      !signature.name.trim() ||
      !Array.isArray(signature.markers) ||
      signature.markers.length === 0 ||
      signature.markers.some(
        (marker) => typeof marker !== "string" || marker.length === 0,
      )
    ) {
      throw new Error(`forbidden signature ${index} is invalid`);
    }
    return signature;
  });
}

/**
 * Match a complete marker set within one emitted chunk. Requiring co-location
 * prevents unrelated strings in different bundles from validating a stale
 * signature. `matchedFile: null` is a hard contract failure for the complete
 * emitted-client scan, and requires an intentional budget-contract update if
 * the dependency was genuinely removed.
 *
 * `matchedFiles` lists EVERY chunk carrying the complete marker set, not just
 * the first. A library that lands in two chunks is a duplicated copy on the
 * CDN, and reporting only the first hit hid that: the Sentry SDK is emitted
 * once per router entrypoint, and the first match happened to be the copy
 * reachable only from the pages-router entry this app does not use.
 */
export function forbiddenSignatureCoverage(signatures, files) {
  const checked = validatedSignatures(signatures);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("emitted JavaScript file set is empty");
  }
  return checked.map((signature) => {
    const matched = files
      .filter(
        ({ content }) =>
          content &&
          signature.markers.every((marker) => content.includes(marker)),
      )
      .map(({ file }) => file);
    return {
      name: signature.name,
      markers: [...signature.markers],
      matchedFile: matched[0] ?? null,
      matchedFiles: matched,
    };
  });
}

export function matchingForbiddenSignatureNames(signatures, files) {
  return forbiddenSignatureCoverage(signatures, files)
    .filter((entry) => entry.matchedFile !== null)
    .map((entry) => entry.name);
}
