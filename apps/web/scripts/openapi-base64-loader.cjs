// SPDX-License-Identifier: AGPL-3.0-only
"use strict";

/**
 * Keep the OpenAPI source out of webpack's JSON/string serializers. Those
 * serializers can reinterpret a textual `\\uD800` schema escape as an actual
 * lone surrogate and emit a server chunk that JSON.parse cannot load.
 *
 * @param {Buffer} source
 * @returns {string}
 */
module.exports = function postwaveOpenapiBase64Loader(source) {
  const encoded = source.toString("base64");
  const dataUrl = `data:application/json;base64,${encoded}`;
  return `export default ${JSON.stringify(dataUrl)};`;
};

module.exports.raw = true;
