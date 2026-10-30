'use strict';

var vscode2 = require('vscode');
var http = require('http');
var crypto = require('crypto');

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var vscode2__namespace = /*#__PURE__*/_interopNamespace(vscode2);
var http__namespace = /*#__PURE__*/_interopNamespace(http);

// src/extension.ts

// src/lib/http.ts
var ResponseBodyTooLargeError = class extends Error {
  constructor(maxBytes) {
    super(`Response body is too large; limit is ${maxBytes} bytes.`);
    this.name = "ResponseBodyTooLargeError";
  }
};
async function readResponseTextLimited(response, maxBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const size = Number(declaredLength);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ResponseBodyTooLargeError(maxBytes);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => void 0);
        throw new ResponseBodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

// src/lib/safe-url.ts
var LOCAL_PREVIEW_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
var BROWSER_AUTH_ORIGINS = /* @__PURE__ */ new Set(["https://app.moosewave.com"]);
var BROWSER_AUTH_PATH = "/cli/auth";
var POSTWAVE_API_KEY_RE = /^pw_[A-Za-z0-9._-]{12,512}$/;
var CONTROL_RE = /[\u0000-\u001f\u007f]/;
function normalizeBrowserAuthUrl(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (CONTROL_RE.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return null;
    if (!BROWSER_AUTH_ORIGINS.has(url.origin)) return null;
    if (url.pathname !== BROWSER_AUTH_PATH) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
function normalizeLocalPreviewBaseUrl(raw, fallback = "http://localhost:4321") {
  const trimmed = (raw ?? fallback).trim();
  if (!trimmed || CONTROL_RE.test(trimmed)) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return fallback;
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    if (!LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())) return fallback;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}
function buildLocalPreviewUrl(baseRaw, fileRel) {
  const base = normalizeLocalPreviewBaseUrl(baseRaw);
  const safeFileRel = normalizePreviewFilePath(fileRel);
  if (!safeFileRel) return `${base}/preview`;
  return `${base}/preview/${encodeURIComponent(safeFileRel)}`;
}
function normalizePreviewFilePath(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || CONTROL_RE.test(trimmed) || trimmed.includes("\\")) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith("//")) {
    return null;
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return null;
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => isUnsafePathSegment(part))) return null;
  return trimmed;
}
function buildLocalPreviewApiUrl(baseRaw, path) {
  const base = normalizeLocalPreviewBaseUrl(baseRaw);
  const rawPath = String(path || "");
  if (rawPath.trim() !== rawPath || CONTROL_RE.test(rawPath) || rawPath.includes("\\")) {
    throw new Error("Unsafe local preview API path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error("Unsafe local preview API path");
  }
  const relativePath = rawPath.replace(/^\/+/, "");
  const pathOnly = relativePath.split(/[?#]/, 1)[0] ?? "";
  if (pathOnly.split("/").some((segment) => isUnsafePathSegment(segment))) {
    throw new Error("Unsafe local preview API path");
  }
  return new URL(`./${relativePath}`, `${base}/`).toString();
}
function isUnsafePathSegment(segment) {
  let current = segment;
  for (let i = 0; i < 2; i += 1) {
    const lower = current.toLowerCase();
    if (current === "." || current === ".." || lower === "%2e" || lower === "%2e." || lower === ".%2e" || lower === "%2e%2e" || CONTROL_RE.test(current) || current.includes("\\")) {
      return true;
    }
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current === "." || current === ".." || CONTROL_RE.test(current) || current.includes("\\");
}
function isPostwaveApiKey(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return trimmed === raw && POSTWAVE_API_KEY_RE.test(trimmed);
}
function isSafeHeaderValue(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  return Boolean(trimmed) && trimmed === raw && !/[\u0000-\u001f\u007f]/.test(trimmed);
}
function normalizePreviewWidth(raw, fallback = "desktop") {
  return raw === "mobile" || raw === "desktop" ? raw : fallback;
}

// src/lib/cli-auth.ts
var AUTH_URL = "https://app.moosewave.com/cli/auth";
var TOKEN_URL = "https://api.moosewave.com/api/v1/auth/cli/token";
var TOKEN_TIMEOUT_MS = 15e3;
var MAX_TOKEN_RESPONSE_BYTES = 8 * 1024;
var CALLBACK_CODE_RE = /^[A-Za-z0-9_-]{32,256}$/;
var PKCE_VALUE_RE = /^[A-Za-z0-9_-]{32,256}$/;
var CONTROL_RE2 = /[\u0000-\u001f\u007f]/;
function createCliPkceRequest() {
  const state = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { state, codeVerifier, codeChallenge };
}
function buildCliBrowserAuthorizationUrl(port, request) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !PKCE_VALUE_RE.test(request.state) || !PKCE_VALUE_RE.test(request.codeVerifier) || !PKCE_VALUE_RE.test(request.codeChallenge)) {
    return null;
  }
  const url = new URL(AUTH_URL);
  url.searchParams.set("source", "vscode");
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("challenge_method", "S256");
  return normalizeBrowserAuthUrl(url.toString());
}
function inspectCliLoopbackCallback(method, rawUrl, expectedState) {
  if (method !== "GET") {
    return { accepted: false, status: 405, message: "method not allowed" };
  }
  if (!rawUrl || CONTROL_RE2.test(rawUrl)) {
    return { accepted: false, status: 400, message: "invalid callback URL" };
  }
  let url;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return { accepted: false, status: 400, message: "invalid callback URL" };
  }
  if (url.origin !== "http://127.0.0.1" || url.pathname !== "/callback") {
    return { accepted: false, status: 404, message: "not found" };
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "code" && key !== "state") || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) {
    return {
      accepted: false,
      status: 400,
      message: "invalid callback parameters"
    };
  }
  const state = url.searchParams.get("state") ?? "";
  if (!constantTimeEqual(state, expectedState)) {
    return { accepted: false, status: 400, message: "state mismatch" };
  }
  const code = url.searchParams.get("code") ?? "";
  if (!CALLBACK_CODE_RE.test(code)) {
    return {
      accepted: false,
      status: 400,
      message: "invalid authorization code"
    };
  }
  return { accepted: true, code, status: 200, message: "authorized" };
}
async function exchangeCliAuthorizationCode(code, request, fetchImpl = fetch) {
  if (!CALLBACK_CODE_RE.test(code) || !PKCE_VALUE_RE.test(request.state) || !PKCE_VALUE_RE.test(request.codeVerifier)) {
    throw new Error("invalid CLI authorization exchange input");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        code,
        code_verifier: request.codeVerifier,
        state: request.state
      }),
      redirect: "error",
      signal: controller.signal
    });
    const body = await readResponseTextLimited(
      response,
      MAX_TOKEN_RESPONSE_BYTES
    );
    if (!response.ok) {
      throw new Error(`Moosewave token exchange returned ${response.status}`);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("Moosewave token exchange returned invalid JSON");
    }
    const apiKey = payload && typeof payload === "object" && "api_key" in payload ? payload.api_key : void 0;
    if (!isPostwaveApiKey(apiKey)) {
      throw new Error("Moosewave token exchange returned no valid API key");
    }
    return apiKey;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Moosewave token exchange timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

// src/commands/login.ts
var CALLBACK_TIMEOUT_MS = 5 * 6e4;
async function loginCommand(context) {
  const pkce = createCliPkceRequest();
  let loopback;
  try {
    loopback = await startLoopback(pkce.state);
    const authUrl = buildCliBrowserAuthorizationUrl(loopback.port, pkce);
    if (!authUrl) throw new Error("could not create a safe authorization URL");
    const opened = await vscode2__namespace.env.openExternal(vscode2__namespace.Uri.parse(authUrl));
    if (!opened)
      throw new Error("VS Code could not open the authorization page");
    void vscode2__namespace.window.showInformationMessage(
      "Moosewave: approve the sign-in request in your browser."
    );
    const code = await loopback.done;
    const apiKey = await exchangeCliAuthorizationCode(code, pkce);
    await context.secrets.store("postwave.apiKey", apiKey);
    void vscode2__namespace.window.showInformationMessage(
      "Moosewave: signed in successfully."
    );
  } catch (error) {
    void vscode2__namespace.window.showErrorMessage(
      `Moosewave sign-in failed: ${safeErrorMessage(error)}`
    );
  } finally {
    loopback?.dispose();
  }
}
async function logoutCommand(context) {
  await context.secrets.delete("postwave.apiKey");
  void vscode2__namespace.window.showInformationMessage(
    "Moosewave: local sign-in credential removed."
  );
}
async function startLoopback(expectedState) {
  let settled = false;
  let timeout;
  let resolveCode = () => {
  };
  let rejectCode = () => {
  };
  const done = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const settleResolve = (code) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    resolveCode(code);
  };
  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    rejectCode(error);
  };
  const server = http__namespace.createServer((req, res) => {
    if (settled) {
      writeLoopbackResponse(
        res,
        410,
        "authorization request already completed"
      );
      return;
    }
    const decision = inspectCliLoopbackCallback(
      req.method,
      req.url,
      expectedState
    );
    writeLoopbackResponse(res, decision.status, decision.message);
    if (decision.accepted && decision.code) settleResolve(decision.code);
  });
  await new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onListenError);
      resolve();
    });
  });
  server.on("error", (error) => settleReject(error));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not determine the loopback listener port");
  }
  timeout = setTimeout(
    () => settleReject(new Error("browser authorization timed out")),
    CALLBACK_TIMEOUT_MS
  );
  const dispose = () => {
    if (!settled) {
      settled = true;
      if (timeout) clearTimeout(timeout);
    }
    server.close();
  };
  return { server, port: address.port, done, dispose };
}
function writeLoopbackResponse(response, status, message) {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(message);
}
function safeErrorMessage(error) {
  if (!(error instanceof Error)) return "unknown error";
  const message = error.message.trim();
  if (!message || /[\u0000-\u001f\u007f]/.test(message)) return "unknown error";
  return message.slice(0, 240);
}
var SEND_TEST_TIMEOUT_MS = 15e3;
var SEND_TEST_MAX_ERROR_BYTES = 8 * 1024;
async function sendTestCommand(context) {
  const editor = vscode2__namespace.window.activeTextEditor;
  if (!editor) {
    void vscode2__namespace.window.showErrorMessage("Moosewave: no active editor.");
    return;
  }
  const recipient = await vscode2__namespace.window.showInputBox({
    prompt: "Send test email to which address?",
    placeHolder: "you@example.com",
    validateInput: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Invalid email address."
  });
  if (!recipient) return;
  const subject = await vscode2__namespace.window.showInputBox({
    prompt: "Subject line for the test email",
    value: "Moosewave preview",
    validateInput: (v) => v.trim().length > 0 && v.trim().length <= 180 ? null : "Subject must be 1-180 characters."
  });
  if (subject === void 0) return;
  const cfg = vscode2__namespace.workspace.getConfiguration("postwave");
  const base = normalizeLocalPreviewBaseUrl(
    cfg.get("devServerUrl") ?? "http://localhost:4321"
  );
  const sendTestUrl = buildLocalPreviewApiUrl(base, "/api/send-test");
  const apiKey = await context.secrets.get("postwave.apiKey") ?? "";
  const rel = vscode2__namespace.workspace.asRelativePath(editor.document.uri, false);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEND_TEST_TIMEOUT_MS);
  try {
    const resp = await fetch(sendTestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...isSafeHeaderValue(apiKey) ? { authorization: `Bearer ${apiKey}` } : {}
      },
      signal: ac.signal,
      body: JSON.stringify({ path: rel, to: recipient, subject })
    });
    if (!resp.ok) {
      let body = "";
      try {
        body = await readResponseTextLimited(resp, SEND_TEST_MAX_ERROR_BYTES);
      } catch (err) {
        body = err instanceof ResponseBodyTooLargeError ? `error response exceeded ${SEND_TEST_MAX_ERROR_BYTES} bytes` : "could not read error response";
      }
      void vscode2__namespace.window.showErrorMessage(
        `Moosewave send-test failed (${resp.status}): ${body.slice(0, 200)}`
      );
      return;
    }
    void vscode2__namespace.window.showInformationMessage(
      `Moosewave: test email queued to ${recipient}.`
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    void vscode2__namespace.window.showErrorMessage(
      timedOut ? `Moosewave: send-test timed out after ${SEND_TEST_TIMEOUT_MS / 1e3}s.` : `Moosewave: could not reach dev server at ${base}. Run \`postwave dev\`. (${err.message})`
    );
  } finally {
    clearTimeout(timer);
  }
}

// src/lint/rules/hidden-text.ts
var PATTERNS = [
  { re: /display\s*:\s*['"]?none['"]?/gi, reason: "display: none" },
  { re: /visibility\s*:\s*['"]?hidden['"]?/gi, reason: "visibility: hidden" },
  {
    re: /position\s*:\s*['"]?absolute['"]?[^;}]*(?:left|top)\s*:\s*['"]?-\d{3,}/gi,
    reason: "off-screen positioning"
  },
  {
    re: /color\s*:\s*['"]?(?:#fff(?:fff)?|white|transparent|rgba?\([^)]*,\s*0(?:\.0+)?\s*\))['"]?/gi,
    reason: "invisible text color"
  }
];
var hiddenText = (source) => {
  const out = [];
  for (const { re, reason } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      out.push({
        ruleId: "postwave/hidden-text",
        message: `${reason} is a strong spam signal. Remove or use a non-hidden equivalent.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning"
      });
    }
  }
  return out;
};

// src/lint/rules/image-ratio.ts
var IMAGE_TAG_RE = /<(?:img|Image|mj-image)\b/gi;
var TAG_STRIP_RE = /<[^>]+>/g;
var imageRatio = (source) => {
  if (!source) return [];
  const images = source.match(IMAGE_TAG_RE)?.length ?? 0;
  if (images === 0) return [];
  const textOnly = source.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(TAG_STRIP_RE, " ").replace(/\s+/g, " ").trim();
  const textLen = textOnly.length;
  const ratio = textLen / Math.max(1, images);
  if (ratio < 200) {
    return [
      {
        ruleId: "postwave/image-ratio",
        message: `Image-to-text ratio is too high (${images} image(s) for ${textLen} chars of text). Add more body copy or remove decorative images.`,
        start: 0,
        end: Math.min(source.length, 1),
        severity: "warning"
      }
    ];
  }
  return [];
};

// src/lint/rules/missing-alt.ts
var TAG_RE = /<(img|Image|mj-image)\b([^>]*?)\/?\s*>/g;
var ALT_RE = /\balt\s*=/i;
var missingAlt = (source) => {
  const out = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(source)) !== null) {
    const attrs = m[2] ?? "";
    if (!ALT_RE.test(attrs)) {
      out.push({
        ruleId: "postwave/missing-alt",
        message: `<${m[1]}> is missing an \`alt\` attribute. Required for accessibility and image-blocked clients.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning"
      });
    }
  }
  return out;
};

// src/lint/rules/obfuscated-spam.ts
var ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;
var NUMERIC_ENTITY_LETTER_RE = /&#(?:6[5-9]|[78]\d|9[0-9]|1[01]\d|12[0-2]);/g;
var CYRILLIC_LOOKALIKE_RE = /[A-Za-z][\u0400-\u04FF]+[A-Za-z]/g;
var obfuscatedSpam = (source) => {
  const out = [];
  ZERO_WIDTH_RE.lastIndex = 0;
  let m;
  while ((m = ZERO_WIDTH_RE.exec(source)) !== null) {
    out.push({
      ruleId: "postwave/obfuscated-spam",
      message: "Zero-width character detected. This is a common spam-obfuscation pattern.",
      start: m.index,
      end: m.index + m[0].length,
      severity: "warning"
    });
  }
  NUMERIC_ENTITY_LETTER_RE.lastIndex = 0;
  while ((m = NUMERIC_ENTITY_LETTER_RE.exec(source)) !== null) {
    out.push({
      ruleId: "postwave/obfuscated-spam",
      message: "Numeric HTML entity used in place of an ASCII letter. Spam filters flag this pattern.",
      start: m.index,
      end: m.index + m[0].length,
      severity: "warning"
    });
  }
  CYRILLIC_LOOKALIKE_RE.lastIndex = 0;
  while ((m = CYRILLIC_LOOKALIKE_RE.exec(source)) !== null) {
    out.push({
      ruleId: "postwave/obfuscated-spam",
      message: "Mixed Latin/Cyrillic word \u2014 likely homograph obfuscation.",
      start: m.index,
      end: m.index + m[0].length,
      severity: "warning"
    });
  }
  return out;
};

// src/lint/rules/outlook-unsupported.ts
var PATTERNS2 = [
  { re: /display\s*:\s*['"]?flex['"]?/gi, reason: "display: flex" },
  { re: /display\s*:\s*['"]?grid['"]?/gi, reason: "display: grid" },
  { re: /(?<![a-zA-Z])gap\s*:\s*['"]?[^;'"}\n]+/gi, reason: "gap" },
  { re: /flex-(?:direction|wrap|grow|shrink|basis)\s*:/gi, reason: "flex-*" },
  { re: /grid-(?:template|area|column|row)[a-z-]*\s*:/gi, reason: "grid-*" }
];
var outlookUnsupported = (source) => {
  const out = [];
  for (const { re, reason } of PATTERNS2) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      out.push({
        ruleId: "postwave/outlook-unsupported",
        message: `\`${reason}\` is not supported by Outlook (Word renderer). Use table layout instead.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning"
      });
    }
  }
  return out;
};

// src/lint/rules/tiny-font.ts
var RE = /font-size\s*:\s*['"]?(\d+(?:\.\d+)?)px/gi;
var MIN_PX = 9;
var tinyFont = (source) => {
  const out = [];
  RE.lastIndex = 0;
  let m;
  while ((m = RE.exec(source)) !== null) {
    const val = Number(m[1]);
    if (Number.isFinite(val) && val < MIN_PX) {
      out.push({
        ruleId: "postwave/tiny-font",
        message: `font-size: ${val}px is below ${MIN_PX}px and may be treated as hidden text by spam filters.`,
        start: m.index,
        end: m.index + m[0].length,
        severity: "warning"
      });
    }
  }
  return out;
};

// src/lint/rules/index.ts
var ALL_RULES = [
  outlookUnsupported,
  missingAlt,
  imageRatio,
  hiddenText,
  tinyFont,
  obfuscatedSpam
];
var MAX_LINT_SOURCE_CHARS = 5e5;
function runAllRules(source) {
  if (source.length > MAX_LINT_SOURCE_CHARS) {
    return [
      {
        ruleId: "postwave/document-too-large",
        message: `Moosewave skipped deliverability lint because this document is larger than ${MAX_LINT_SOURCE_CHARS.toLocaleString()} characters.`,
        start: 0,
        end: Math.min(source.length, 1),
        severity: "info"
      }
    ];
  }
  const out = [];
  for (const rule of ALL_RULES) {
    out.push(...rule(source));
  }
  return out;
}

// src/lint/diagnostics.ts
var SUPPORTED_EXT_RE = /\.(email\.tsx|email\.md|mjml)$/i;
function isPostwaveEmailDoc(doc) {
  return SUPPORTED_EXT_RE.test(doc.uri.fsPath);
}
function findingToDiagnostic(doc, finding) {
  const range = new vscode2__namespace.Range(
    doc.positionAt(finding.start),
    doc.positionAt(finding.end)
  );
  const diag = new vscode2__namespace.Diagnostic(
    range,
    finding.message,
    vscode2__namespace.DiagnosticSeverity.Warning
  );
  diag.source = "postwave";
  diag.code = finding.ruleId;
  return diag;
}
function lintDocument(doc, collection) {
  if (!isPostwaveEmailDoc(doc)) {
    collection.delete(doc.uri);
    return;
  }
  const findings = runAllRules(doc.getText());
  collection.set(doc.uri, findings.map((f) => findingToDiagnostic(doc, f)));
}
function registerDiagnostics(context) {
  const collection = vscode2__namespace.languages.createDiagnosticCollection("postwave");
  context.subscriptions.push(collection);
  for (const doc of vscode2__namespace.workspace.textDocuments) {
    lintDocument(doc, collection);
  }
  context.subscriptions.push(
    vscode2__namespace.workspace.onDidSaveTextDocument((doc) => lintDocument(doc, collection)),
    vscode2__namespace.workspace.onDidOpenTextDocument((doc) => lintDocument(doc, collection)),
    vscode2__namespace.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  );
  return collection;
}
var PostwavePreviewProvider = class {
  constructor(context) {
    this.context = context;
    const cfg = vscode2__namespace.workspace.getConfiguration("postwave");
    this.currentWidth = normalizePreviewWidth(cfg.get("previewWidth"));
  }
  context;
  static viewType = "postwave.preview";
  view;
  currentFileRel;
  currentWidth;
  messageNonce = crypto.randomUUID();
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((msg) => {
      if (!isWebviewCommand(msg)) return;
      switch (msg.type) {
        case "toggle-width":
          this.currentWidth = this.currentWidth === "mobile" ? "desktop" : "mobile";
          this.refresh();
          break;
        case "reload":
          this.refresh();
          break;
        case "send-test":
          void vscode2__namespace.commands.executeCommand("postwave.email.sendTest");
          break;
      }
    });
    this.context.subscriptions.push(
      vscode2__namespace.workspace.onDidSaveTextDocument(() => this.refresh()),
      vscode2__namespace.window.onDidChangeActiveTextEditor(() => this.refresh())
    );
    this.refresh();
  }
  refresh() {
    if (!this.view) return;
    const editor = vscode2__namespace.window.activeTextEditor;
    if (editor) {
      const folder = vscode2__namespace.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        const rel = vscode2__namespace.workspace.asRelativePath(editor.document.uri, false);
        this.currentFileRel = rel;
      } else {
        this.currentFileRel = editor.document.fileName;
      }
    }
    this.view.webview.postMessage({
      type: "navigate",
      url: this.previewUrl(),
      width: this.currentWidth,
      nonce: this.messageNonce
    });
  }
  previewUrl() {
    const cfg = vscode2__namespace.workspace.getConfiguration("postwave");
    const base = cfg.get("devServerUrl") ?? "http://localhost:4321";
    return buildLocalPreviewUrl(base, this.currentFileRel);
  }
  renderHtml() {
    const initialUrl = this.previewUrl();
    const nonce = this.messageNonce;
    return (
      /* html */
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; frame-src http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${escapeAttr(nonce)}';" />
  <title>Moosewave Preview</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .toolbar { display: flex; gap: 6px; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
    .toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
    .frame-wrap { position: absolute; top: 38px; bottom: 0; left: 0; right: 0; display: flex; justify-content: center; background: #1e1e1e; }
    iframe { border: 0; height: 100%; background: #fff; }
    iframe.mobile { width: 375px; }
    iframe.desktop { width: 100%; max-width: 720px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button data-cmd="toggle-width">Mobile / Desktop</button>
    <button data-cmd="reload">Reload</button>
    <button data-cmd="send-test">Send test</button>
  </div>
  <div class="frame-wrap">
    <iframe id="pw-frame" class="${this.currentWidth}" src="${escapeAttr(initialUrl)}"></iframe>
  </div>
  <script nonce="${escapeAttr(nonce)}">
    const MESSAGE_NONCE = ${JSON.stringify(nonce)};
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: btn.getAttribute('data-cmd') });
      });
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'navigate') {
        if (msg.nonce !== MESSAGE_NONCE) return;
        if (!isSafePreviewUrl(msg.url)) return;
        const width = normalizePreviewWidth(msg.width);
        if (!width) return;
        const f = document.getElementById('pw-frame');
        f.className = width;
        f.src = msg.url;
      }
    });
    function isSafePreviewUrl(raw) {
      try {
        const url = new URL(String(raw));
        const host = url.hostname.toLowerCase();
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
          (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.pathname === '/preview' || url.pathname.startsWith('/preview/'));
      } catch {
        return false;
      }
    }
    function normalizePreviewWidth(raw) {
      return raw === 'mobile' || raw === 'desktop' ? raw : null;
    }
  </script>
</body>
</html>`
    );
  }
};
function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function isWebviewCommand(raw) {
  if (!raw || typeof raw !== "object") return false;
  const type = raw.type;
  return type === "toggle-width" || type === "reload" || type === "send-test";
}
var POLL_INTERVAL_MS = 1e4;
var PostwaveStatusBar = class {
  item;
  timer;
  connected = false;
  constructor() {
    this.item = vscode2__namespace.window.createStatusBarItem(
      vscode2__namespace.StatusBarAlignment.Right,
      100
    );
    this.item.command = "postwave.preview.open";
    this.render();
    this.item.show();
  }
  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }
  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
  async poll() {
    const cfg = vscode2__namespace.workspace.getConfiguration("postwave");
    const healthUrl = buildLocalPreviewApiUrl(
      cfg.get("devServerUrl") ?? "http://localhost:4321",
      "/health"
    );
    let ok = false;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3e3);
      try {
        const resp = await fetch(healthUrl, { signal: ac.signal });
        ok = resp.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      ok = false;
    }
    if (ok !== this.connected) {
      this.connected = ok;
      this.render();
    }
  }
  render() {
    if (this.connected) {
      this.item.text = "$(circle-filled) Moosewave";
      this.item.tooltip = "Moosewave dev server: connected";
      this.item.color = new vscode2__namespace.ThemeColor("charts.green");
    } else {
      this.item.text = "$(circle-outline) Moosewave";
      this.item.tooltip = "Moosewave dev server: disconnected. Run `postwave dev`.";
      this.item.color = new vscode2__namespace.ThemeColor("charts.red");
    }
  }
};

// src/extension.ts
function activate(context) {
  const provider = new PostwavePreviewProvider(context);
  context.subscriptions.push(
    vscode2__namespace.window.registerWebviewViewProvider(
      PostwavePreviewProvider.viewType,
      provider
    )
  );
  registerDiagnostics(context);
  const statusBar = new PostwaveStatusBar();
  statusBar.start();
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode2__namespace.commands.registerCommand("postwave.preview.open", async () => {
      await vscode2__namespace.commands.executeCommand("workbench.view.extension.postwave");
      provider.refresh();
    }),
    vscode2__namespace.commands.registerCommand(
      "postwave.email.sendTest",
      () => sendTestCommand(context)
    ),
    vscode2__namespace.commands.registerCommand("postwave.devServer.start", async () => {
      const term = vscode2__namespace.window.createTerminal("Moosewave dev");
      term.show();
      term.sendText("npx postwave dev");
    }),
    vscode2__namespace.commands.registerCommand(
      "postwave.login",
      () => loginCommand(context)
    ),
    vscode2__namespace.commands.registerCommand(
      "postwave.logout",
      () => logoutCommand(context)
    )
  );
}
function deactivate() {
}

exports.activate = activate;
exports.deactivate = deactivate;
