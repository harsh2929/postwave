import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const POLICY_PATH = "packages/openapi/route-reachability.json";
const INTERNAL_IMPORT_PREFIX =
  "github.com/postwave/postwave/apps/api/internal/";
const INTERNAL_SOURCE_PREFIX = "apps/api/internal/";

function normalizeRelativePath(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty repository-relative path`);
  }
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`${field} must stay inside the repository: ${value}`);
  }
  return normalized.replace(/\/$/u, "");
}

function readRequiredCalls(entry, index) {
  const field = `additional_sources[${index}].required_calls`;
  if (
    !Array.isArray(entry.required_calls) ||
    entry.required_calls.length === 0
  ) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return entry.required_calls.map((call, callIndex) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw new Error(`${field}[${callIndex}] must be an object`);
    }
    const source = normalizeRelativePath(
      call.source,
      `${field}[${callIndex}].source`,
    );
    if (!source.endsWith(".go")) {
      throw new Error(`${field}[${callIndex}].source must name a Go file`);
    }
    const functionName = String(call.function ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(functionName)) {
      throw new Error(`${field}[${callIndex}].function is invalid`);
    }
    const symbol = String(call.symbol ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(symbol)) {
      throw new Error(`${field}[${callIndex}].symbol is invalid`);
    }
    return { source, function: functionName, symbol };
  });
}

// Mask comments and string/rune literals while preserving byte positions and
// braces. Required mount predicates must be executable Go, never a comment or
// a diagnostic string that happens to mention the expected call.
export function maskGoNonCode(source) {
  const chars = source.split("");
  let state = "code";
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "line-comment";
      } else if (current === "/" && next === "*") {
        chars[index] = " ";
        chars[index + 1] = " ";
        index += 1;
        state = "block-comment";
      } else if (current === '"') {
        chars[index] = " ";
        state = "quoted-string";
        escaped = false;
      } else if (current === "'") {
        chars[index] = " ";
        state = "rune";
        escaped = false;
      } else if (current === "`") {
        chars[index] = " ";
        state = "raw-string";
      }
      continue;
    }

    if (current !== "\n" && current !== "\r") chars[index] = " ";
    if (state === "line-comment") {
      if (current === "\n") state = "code";
    } else if (state === "block-comment") {
      if (current === "*" && next === "/") {
        chars[index + 1] = " ";
        index += 1;
        state = "code";
      }
    } else if (state === "raw-string") {
      if (current === "`") state = "code";
    } else if (escaped) {
      escaped = false;
    } else if (current === "\\") {
      escaped = true;
    } else if (
      (state === "quoted-string" && current === '"') ||
      (state === "rune" && current === "'")
    ) {
      state = "code";
    }
  }
  return chars.join("");
}

function functionRange(maskedSource, functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const declaration = new RegExp(
    `\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${escaped}\\s*\\(`,
    "gu",
  );
  const matches = [...maskedSource.matchAll(declaration)];
  if (matches.length !== 1) return null;
  const bodyStart = maskedSource.indexOf("{", matches[0].index);
  if (bodyStart < 0) return null;
  let depth = 0;
  for (let index = bodyStart; index < maskedSource.length; index += 1) {
    if (maskedSource[index] === "{") depth += 1;
    else if (maskedSource[index] === "}") {
      depth -= 1;
      if (depth === 0) return [bodyStart, index + 1];
    }
  }
  return null;
}

function validateRequiredCalls(repoRoot, additionalSources) {
  const sourceCache = new Map();
  for (const entry of additionalSources) {
    for (const call of entry.requiredCalls) {
      let masked = sourceCache.get(call.source);
      if (masked == null) {
        try {
          masked = maskGoNonCode(
            readFileSync(resolve(repoRoot, call.source), "utf8"),
          );
        } catch (error) {
          throw new Error(
            `required mount source ${call.source} for ${entry.path} cannot be read: ${error.message}`,
            { cause: error },
          );
        }
        sourceCache.set(call.source, masked);
      }
      const range = functionRange(masked, call.function);
      if (range == null) {
        throw new Error(
          `required mount function ${call.function} in ${call.source} for ${entry.path} is missing or ambiguous`,
        );
      }
      const body = masked.slice(range[0], range[1]);
      const escapedSymbol = call.symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (!new RegExp(`\\b${escapedSymbol}\\s*\\(`, "u").test(body)) {
        throw new Error(
          `required mount call ${call.symbol} in ${call.source}#${call.function} is absent; ${entry.path} is not reachable`,
        );
      }
    }
  }
}

export function validateAdditionalSourceMounts(repoRoot) {
  const root = resolve(repoRoot);
  const policy = loadPolicy(root);
  validateRequiredCalls(root, policy.additionalSources);
}

function loadPolicy(repoRoot) {
  const policyFile = resolve(repoRoot, POLICY_PATH);
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyFile, "utf8"));
  } catch (error) {
    throw new Error(`cannot load ${POLICY_PATH}: ${error.message}`, {
      cause: error,
    });
  }
  if (policy.version !== 1) {
    throw new Error(`${POLICY_PATH} must declare version 1`);
  }
  const compositionRoot = normalizeRelativePath(
    policy.composition_root,
    "composition_root",
  );
  if (!Array.isArray(policy.additional_sources)) {
    throw new Error(`${POLICY_PATH} additional_sources must be an array`);
  }
  if (!Array.isArray(policy.forbidden_composition_calls)) {
    throw new Error(
      `${POLICY_PATH} forbidden_composition_calls must be an array`,
    );
  }
  if (!Array.isArray(policy.excluded_routes)) {
    throw new Error(`${POLICY_PATH} excluded_routes must be an array`);
  }
  if (!Array.isArray(policy.excluded_sources)) {
    throw new Error(`${POLICY_PATH} excluded_sources must be an array`);
  }

  const readEntries = (entries, field) =>
    entries.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`${field}[${index}] must be an object`);
      }
      const path = normalizeRelativePath(entry.path, `${field}[${index}].path`);
      if (!path.startsWith(INTERNAL_SOURCE_PREFIX)) {
        throw new Error(
          `${field}[${index}].path must be under ${INTERNAL_SOURCE_PREFIX}`,
        );
      }
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        throw new Error(`${field}[${index}].reason must be non-empty`);
      }
      const result = { path, reason: entry.reason.trim() };
      if (field === "additional_sources") {
        result.requiredCalls = readRequiredCalls(entry, index);
      }
      return result;
    });

  return {
    compositionRoot,
    additionalSources: readEntries(
      policy.additional_sources,
      "additional_sources",
    ),
    forbiddenCompositionCalls: policy.forbidden_composition_calls.map(
      (entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error(
            `forbidden_composition_calls[${index}] must be an object`,
          );
        }
        const symbol = String(entry.symbol ?? "").trim();
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(symbol)
        ) {
          throw new Error(
            `forbidden_composition_calls[${index}].symbol is invalid`,
          );
        }
        if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
          throw new Error(
            `forbidden_composition_calls[${index}].reason must be non-empty`,
          );
        }
        return { symbol, reason: entry.reason.trim() };
      },
    ),
    excludedSources: readEntries(policy.excluded_sources, "excluded_sources"),
    excludedRoutes: policy.excluded_routes.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`excluded_routes[${index}] must be an object`);
      }
      const method = String(entry.method ?? "")
        .trim()
        .toUpperCase();
      if (
        !new Set([
          "GET",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
        ]).has(method)
      ) {
        throw new Error(`excluded_routes[${index}].method is invalid`);
      }
      const path = String(entry.path ?? "").trim();
      if (!path.startsWith("/api/")) {
        throw new Error(`excluded_routes[${index}].path must start with /api/`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
        throw new Error(`excluded_routes[${index}].reason must be non-empty`);
      }
      return { method, path, reason: entry.reason.trim() };
    }),
  };
}

function pathMatchesRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

export function directInternalImports(mainSource) {
  const imports = new Set();
  const importPattern = /"([^"]+)"/gu;
  let match;
  while ((match = importPattern.exec(mainSource)) !== null) {
    if (!match[1].startsWith(INTERNAL_IMPORT_PREFIX)) continue;
    imports.add(
      `${INTERNAL_SOURCE_PREFIX}${match[1].slice(INTERNAL_IMPORT_PREFIX.length)}`,
    );
  }
  return [...imports].sort();
}

function repositoryRelativePath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function walkGoFiles(repoRoot, path, excludedSources, out) {
  const sourcePath = repositoryRelativePath(repoRoot, path);
  if (
    excludedSources.some((entry) => pathMatchesRoot(sourcePath, entry.path))
  ) {
    return;
  }
  const stats = statSync(path);
  if (!stats.isDirectory()) {
    if (path.endsWith(".go") && !path.endsWith("_test.go")) out.push(path);
    return;
  }
  for (const entry of readdirSync(path).sort()) {
    if (entry === "node_modules" || entry === ".git" || entry === "vendor") {
      continue;
    }
    walkGoFiles(repoRoot, join(path, entry), excludedSources, out);
  }
}

/**
 * Return only Go sources reachable from the API composition root.
 *
 * Internal packages are fail-closed: a package is scanned only when main.go
 * imports it directly, or when route-reachability.json names a reviewed
 * transitive source. Explicit exclusions override discovery, and importing an
 * excluded scaffold is a hard error so a future mount cannot silently publish
 * unfinished handlers.
 */
export function reachableRouteSourceFiles(repoRoot) {
  const root = resolve(repoRoot);
  const policy = loadPolicy(root);
  const compositionRoot = resolve(root, policy.compositionRoot);
  const mainSource = readFileSync(compositionRoot, "utf8");
  const maskedMainSource = maskGoNonCode(mainSource);
  for (const entry of policy.forbiddenCompositionCalls) {
    const escaped = entry.symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`\\b${escaped}\\s*\\(`, "u").test(maskedMainSource)) {
      throw new Error(
        `API composition calls forbidden route mount ${entry.symbol}: ${entry.reason}`,
      );
    }
  }
  validateRequiredCalls(root, policy.additionalSources);
  const discovered = directInternalImports(mainSource);
  const candidates = [
    policy.compositionRoot,
    ...discovered,
    ...policy.additionalSources.map((entry) => entry.path),
  ];

  for (const source of candidates.slice(1)) {
    const exclusion = policy.excludedSources.find((entry) =>
      pathMatchesRoot(source, entry.path),
    );
    if (exclusion) {
      throw new Error(
        `API composition imports excluded route source ${source}: ${exclusion.reason}`,
      );
    }
  }

  const uniqueRoots = [...new Set(candidates)].sort();
  const files = [];
  for (const source of uniqueRoots) {
    const absolute = resolve(root, source);
    const relativePath = relative(root, absolute);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`route source escapes repository: ${source}`);
    }
    walkGoFiles(root, absolute, policy.excludedSources, files);
  }
  return [...new Set(files)].sort();
}

export function excludedRouteContracts(repoRoot) {
  return loadPolicy(resolve(repoRoot)).excludedRoutes;
}

export const routeReachabilityPolicyPath = POLICY_PATH;

const VERB_RE =
  /\.\s*(Get|Post|Patch|Put|Delete|Head|Options|Handle)\s*\(\s*"([^"]+)"/gu;
const METHOD_RE =
  /\.Method\s*\(\s*(?:(?:http\.Method)?(\w+)|"(\w+)")\s*,\s*"([^"]+)"/gu;

function normalizeGatewayPath(path) {
  let normalized = path.replace(/\/\*$/u, "/{rest}");
  normalized = normalized.replace(/\{([^}:]+):[^}]+\}/gu, "{$1}");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function gatewayRouteKey(method, path) {
  return `${method.toUpperCase()} ${normalizeGatewayPath(path)}`;
}

function goFunctionSource(repoRoot, sourcePath, functionName) {
  const raw = readFileSync(resolve(repoRoot, sourcePath), "utf8");
  const masked = maskGoNonCode(raw);
  const range = functionRange(masked, functionName);
  if (range == null) {
    throw new Error(
      `gateway composition function ${sourcePath}#${functionName} is missing or ambiguous`,
    );
  }
  return {
    raw: raw.slice(range[0], range[1]),
    masked: masked.slice(range[0], range[1]),
  };
}

function requireFunctionCall(source, symbol, context) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (!new RegExp(`\\b${escaped}\\s*\\(`, "u").test(source.masked)) {
    throw new Error(
      `${context} is unreachable because executable call ${symbol} is absent`,
    );
  }
}

function executableMatch(masked, match, callPattern) {
  const code = masked.slice(match.index, match.index + match[0].length);
  return callPattern.test(code);
}

export function extractAbsoluteRoutes(raw, masked) {
  const routes = new Set();
  VERB_RE.lastIndex = 0;
  let match;
  while ((match = VERB_RE.exec(raw)) !== null) {
    const verb = match[1];
    if (
      !executableMatch(masked, match, new RegExp(`\\.\\s*${verb}\\s*\\(`, "u"))
    ) {
      continue;
    }
    if (!match[2].startsWith("/api/")) continue;
    routes.add(
      gatewayRouteKey(verb.toUpperCase() === "HANDLE" ? "ANY" : verb, match[2]),
    );
  }
  METHOD_RE.lastIndex = 0;
  while ((match = METHOD_RE.exec(raw)) !== null) {
    if (!executableMatch(masked, match, /\.Method\s*\(/u)) continue;
    const method = (match[1] || match[2] || "").toUpperCase();
    if (!method || !match[3].startsWith("/api/")) continue;
    routes.add(gatewayRouteKey(method, match[3]));
  }
  return routes;
}

function extractRelativeRoutes(raw, masked, base) {
  const routes = new Set();
  VERB_RE.lastIndex = 0;
  let match;
  while ((match = VERB_RE.exec(raw)) !== null) {
    const verb = match[1];
    if (
      !executableMatch(masked, match, new RegExp(`\\.\\s*${verb}\\s*\\(`, "u"))
    ) {
      continue;
    }
    const suffix = match[2];
    if (!suffix.startsWith("/")) continue;
    const path = suffix === "/" ? base : `${base}${suffix}`;
    routes.add(
      gatewayRouteKey(verb.toUpperCase() === "HANDLE" ? "ANY" : verb, path),
    );
  }
  return routes;
}

function mergeRoutes(target, source) {
  for (const route of source) target.add(route);
}

function braceRange(masked, bodyStart) {
  let depth = 0;
  for (let index = bodyStart; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}") {
      depth -= 1;
      if (depth === 0) return [bodyStart, index + 1];
    }
  }
  return null;
}

function routeBlocks(source) {
  const blocks = [];
  const pattern =
    /\.Route\(\s*"([^"]+)"\s*,\s*func\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+chi\.Router\s*\)\s*\{/gu;
  let match;
  while ((match = pattern.exec(source.raw)) !== null) {
    if (!executableMatch(source.masked, match, /\.Route\s*\(/u)) continue;
    const bodyStart = source.raw.indexOf("{", match.index);
    const range = braceRange(source.masked, bodyStart);
    if (range == null) {
      throw new Error(`unterminated chi Route block for ${match[1]}`);
    }
    blocks.push({
      base: match[1],
      router: match[2],
      start: match.index,
      end: range[1],
      raw: source.raw.slice(range[0], range[1]),
      masked: source.masked.slice(range[0], range[1]),
    });
  }
  return blocks;
}

function extractMigrationSidecarRoutes(repoRoot) {
  const gatewayMain = goFunctionSource(repoRoot, "apps/api/main.go", "run");
  for (const path of ["/api/v1/migrations", "/api/v1/migrations/*"]) {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const rawPattern = new RegExp(
      `\\.Handle\\s*\\(\\s*"${escapedPath}"\\s*,\\s*migrationProxy\\s*\\)`,
      "gu",
    );
    const matches = [...gatewayMain.raw.matchAll(rawPattern)];
    if (
      matches.length !== 1 ||
      !executableMatch(gatewayMain.masked, matches[0], /\.Handle\s*\(/u)
    ) {
      throw new Error(
        `migration sidecar is unreachable because the exact migrationProxy mount ${path} is absent`,
      );
    }
  }
  const serviceMain = goFunctionSource(
    repoRoot,
    "services/migration/main.go",
    "run",
  );
  requireFunctionCall(serviceMain, "migrationAPI.Mount", "migration sidecar");
  const mount = goFunctionSource(
    repoRoot,
    "services/migration/internal/handlers/migration.go",
    "Mount",
  );
  return extractRelativeRoutes(mount.raw, mount.masked, "/api/v1/migrations");
}

function extractOpsConsoleRoutes(repoRoot) {
  const main = goFunctionSource(repoRoot, "apps/api/main.go", "run");
  requireFunctionCall(main, "mountOpsRoutes", "ops console");
  const mount = goFunctionSource(
    repoRoot,
    "apps/api/ops_console_wiring.go",
    "mountOpsRoutes",
  );
  const outer = routeBlocks(mount).find(
    (block) => block.base === "/api/internal/ops",
  );
  if (outer == null) {
    throw new Error(
      "ops console is unreachable because its /api/internal/ops Route block is absent",
    );
  }
  const views = routeBlocks({ raw: outer.raw, masked: outer.masked }).find(
    (block) => block.base === "/views",
  );
  const routes = new Set();
  if (views == null) {
    mergeRoutes(
      routes,
      extractRelativeRoutes(outer.raw, outer.masked, outer.base),
    );
    return routes;
  }
  mergeRoutes(
    routes,
    extractRelativeRoutes(
      outer.raw.slice(0, views.start),
      outer.masked.slice(0, views.start),
      outer.base,
    ),
  );
  mergeRoutes(
    routes,
    extractRelativeRoutes(
      views.raw,
      views.masked,
      `${outer.base}${views.base}`,
    ),
  );
  return routes;
}

function extractMailchimpV3Routes(repoRoot) {
  const main = goFunctionSource(repoRoot, "apps/api/main.go", "run");
  requireFunctionCall(
    main,
    "mailchimpv3.Mount",
    "Mailchimp v3 compatibility surface",
  );
  const publicMount = goFunctionSource(
    repoRoot,
    "apps/api/internal/mailchimpv3/handlers.go",
    "Mount",
  );
  const basePattern = /\bmountBase\s*\(\s*[^,]+,\s*"([^"]+)"/gu;
  const bases = [];
  let match;
  while ((match = basePattern.exec(publicMount.raw)) !== null) {
    if (!executableMatch(publicMount.masked, match, /\bmountBase\s*\(/u)) {
      continue;
    }
    if (match[1].startsWith("/api/")) bases.push(match[1]);
  }
  if (bases.length === 0) {
    throw new Error(
      "Mailchimp v3 compatibility surface has no executable /api mountBase call",
    );
  }
  const mountBase = goFunctionSource(
    repoRoot,
    "apps/api/internal/mailchimpv3/handlers.go",
    "mountBase",
  );
  const routes = new Set();
  const baseVerbPattern =
    /\.\s*(Get|Post|Patch|Put|Delete|Head|Options|Handle)\s*\(\s*base(?:\s*\+\s*"([^"]*)")?\s*,/gu;
  let routeMatch;
  while ((routeMatch = baseVerbPattern.exec(mountBase.raw)) !== null) {
    const verb = routeMatch[1];
    if (
      !executableMatch(
        mountBase.masked,
        routeMatch,
        new RegExp(`\\.\\s*${verb}\\s*\\(`, "u"),
      )
    ) {
      continue;
    }
    const suffix = routeMatch[2] ?? "";
    for (const base of bases) {
      routes.add(
        gatewayRouteKey(
          verb.toUpperCase() === "HANDLE" ? "ANY" : verb,
          `${base}${suffix}`,
        ),
      );
    }
  }
  if (routes.size === 0) {
    throw new Error(
      "Mailchimp v3 compatibility mountBase declares no executable routes",
    );
  }
  return routes;
}

function extractNBPRoutes(repoRoot) {
  const main = goFunctionSource(repoRoot, "apps/api/main.go", "run");
  requireFunctionCall(
    main,
    "apiserver.MountEditorQueueRoutes",
    "NBP surface composition root",
  );
  const editorQueueMount = goFunctionSource(
    repoRoot,
    "apps/api/internal/server/editor_queue_routes.go",
    "MountEditorQueueRoutes",
  );
  requireFunctionCall(editorQueueMount, "nbp.Mount", "NBP surface helper");
  const mount = goFunctionSource(
    repoRoot,
    "apps/api/internal/nbp/handlers.go",
    "Mount",
  );
  const routes = extractAbsoluteRoutes(mount.raw, mount.masked);
  if (routes.size === 0) {
    throw new Error(
      "NBP surface is unreachable because nbp.Mount declares no executable /api routes",
    );
  }
  return routes;
}

export function compositeGatewayRouteInventory(repoRoot) {
  const root = resolve(repoRoot);
  return {
    migrationSidecar: extractMigrationSidecarRoutes(root),
    opsConsole: extractOpsConsoleRoutes(root),
    mailchimpV3: extractMailchimpV3Routes(root),
    nbp: extractNBPRoutes(root),
  };
}

/**
 * Return the single authoritative executable gateway route boundary consumed
 * by both parity and authorization-manifest generation. Relative/composite
 * surfaces are admitted only after their complete call chain is proven.
 */
export function gatewayRouteInventory(repoRoot) {
  const root = resolve(repoRoot);
  const reachable = new Set();
  for (const path of reachableRouteSourceFiles(root)) {
    const raw = readFileSync(path, "utf8");
    mergeRoutes(reachable, extractAbsoluteRoutes(raw, maskGoNonCode(raw)));
  }
  const composites = compositeGatewayRouteInventory(root);
  const routes = new Set(reachable);
  for (const composite of Object.values(composites)) {
    mergeRoutes(routes, composite);
  }
  for (const excluded of excludedRouteContracts(root)) {
    const key = gatewayRouteKey(excluded.method, excluded.path);
    if (!routes.delete(key)) {
      throw new Error(
        `route-reachability exclusion ${key} no longer matches a reachable route declaration; remove or update the stale policy entry`,
      );
    }
  }
  return { routes, reachable, ...composites };
}
