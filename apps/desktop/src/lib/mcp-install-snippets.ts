/**
 * Install / configuration snippets for every supported MCP-aware
 * agent. Source of truth for the dashboard's "Setup" tab.
 *
 * Each snippet is the exact configuration a user pastes into the
 * agent's config to register the Moosewave MCP server. The
 * `{{API_KEY}}` placeholder is substituted with the user's own key
 * at render time (we never embed real keys in this file).
 *
 * D14-settings-misc#7: the snippets also carry `{{BASE_URL_*}}`
 * placeholders. On a self-hosted deployment (or the localhost dev
 * default) the MCP server must be pointed at the operator's own API,
 * not the hosted default — the SDK defaults `POSTWAVE_BASE_URL` to
 * `https://api.moosewave.com`, so a pasted config would otherwise
 * authenticate against the wrong host. `renderSnippet` injects
 * `POSTWAVE_BASE_URL` (in each client's env format) when the caller
 * passes a `baseUrl` that differs from the hosted default, and omits
 * it entirely otherwise so hosted users get a clean snippet.
 *
 * Extracted to its own module so:
 *   1. The strings are unit-testable without React.
 *   2. Adding a new agent client = one entry in this array; no JSX
 *      edits.
 *   3. End-to-end docs stay in sync with the npm-published readme
 *      (packages/mcp-server/README.md) — both source from this
 *      same set of clients.
 */

export interface MCPClientSnippet {
  /** Display name shown in the Setup tab tab list. */
  client: string;
  /** Subtitle shown below the tab title (where the file lives, etc.). */
  hint: string;
  /** Language hint for syntax highlighting. */
  language: "bash" | "json";
  /**
   * The snippet template with `{{API_KEY}}` placeholder substituted
   * server-side before render. Caller MUST replace before display.
   */
  template: string;
}

export const MCP_CLIENTS: readonly MCPClientSnippet[] = [
  {
    client: "Claude Code",
    hint: "Recommended — one-liner via the Claude Code CLI.",
    language: "bash",
    template: `claude mcp add postwave -e POSTWAVE_API_KEY={{API_KEY}}{{BASE_URL_BASH_FLAG}} -- npx -y @postwave/mcp-server`,
  },
  {
    client: "Cursor",
    hint: "Paste into .cursor/mcp.json at your repo root.",
    language: "json",
    template: `{
  "mcpServers": {
    "postwave": {
      "command": "npx",
      "args": ["-y", "@postwave/mcp-server"],
      "env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }
    }
  }
}`,
  },
  {
    client: "Claude Desktop",
    hint: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json — Windows: %APPDATA%\\\\Claude\\\\claude_desktop_config.json — restart the app after saving.",
    language: "json",
    template: `{
  "mcpServers": {
    "postwave": {
      "command": "npx",
      "args": ["-y", "@postwave/mcp-server"],
      "env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }
    }
  }
}`,
  },
  {
    client: "Continue",
    hint: "Paste into ~/.continue/config.json under mcpServers.",
    language: "json",
    template: `{
  "mcpServers": [
    {
      "name": "postwave",
      "command": "npx",
      "args": ["-y", "@postwave/mcp-server"],
      "env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }
    }
  ]
}`,
  },
  {
    client: "Zed",
    hint: "Settings → Context Servers → Add.",
    language: "json",
    template: `{
  "context_servers": {
    "postwave": {
      "command": {
        "path": "npx",
        "args": ["-y", "@postwave/mcp-server"],
        "env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }
      }
    }
  }
}`,
  },
  {
    client: "Windsurf",
    hint: "~/.codeium/windsurf/mcp_config.json — restart Windsurf after saving.",
    language: "json",
    template: `{
  "mcpServers": {
    "postwave": {
      "command": "npx",
      "args": ["-y", "@postwave/mcp-server"],
      "env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }
    }
  }
}`,
  },
  {
    client: "VS Code (1.99+)",
    hint: ".vscode/mcp.json — VS Code's native MCP support, since v1.99.",
    language: "json",
    template: `{
  "servers": {
    "postwave": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@postwave/mcp-server"],
      "env": { "POSTWAVE_API_KEY": "{{API_KEY}}"{{BASE_URL_JSON}} }
    }
  }
}`,
  },
  {
    client: "ChatGPT (Custom Connector)",
    hint: "ChatGPT → Settings → Custom connectors → Add. Use the hosted HTTP transport URL.",
    language: "json",
    template: `{
  "name": "Moosewave",
  "url": "https://mcp.moosewave.com/mcp",
  "auth": {
    "type": "bearer",
    "token": "{{API_KEY}}"
  }
}`,
  },
  {
    client: "Generic HTTP / SSE",
    hint: "Any MCP client supporting HTTP transport. Use these env vars and run the server locally, or hit the hosted endpoint.",
    language: "bash",
    template: `# Run locally (HTTP transport on :3030)
POSTWAVE_API_KEY={{API_KEY}} \\{{BASE_URL_BASH_LINE}}
POSTWAVE_MCP_TRANSPORT=http \\
PORT=3030 \\
npx -y @postwave/mcp-server

# Or hit the hosted endpoint with bearer auth:
#   curl -H "Authorization: Bearer {{API_KEY}}" https://mcp.moosewave.com/mcp`,
  },
];

/**
 * The base URL the MCP server (and the SDK it wraps) defaults to when
 * `POSTWAVE_BASE_URL` is unset — packages/sdk-ts DEFAULT_BASE. When the
 * operator's API URL equals this, the env var is redundant and omitted.
 */
export const HOSTED_MCP_API_BASE = "https://api.moosewave.com";

/** Strip trailing slashes so `https://x/` and `https://x` compare equal. */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Substitute the `{{API_KEY}}` and `{{BASE_URL_*}}` placeholders.
 *
 * Renderer-friendly for the API key: when `apiKey` is empty the
 * `{{API_KEY}}` placeholder is left visible so the UI can prompt the
 * user to mint a key. The base-URL placeholders are ALWAYS resolved
 * (never left visible).
 *
 * `baseUrl` — the operator's real API host (getApiUrl() on the desktop).
 * When it's empty or equals the hosted default the base-URL placeholders
 * expand to nothing (hosted users get the clean snippet); otherwise each
 * expands to the client-appropriate `POSTWAVE_BASE_URL` env entry so a
 * self-hosted / localhost config targets the right API.
 */
export function renderSnippet(
  template: string,
  apiKey: string,
  baseUrl?: string,
): string {
  const base = normalizeBase(baseUrl ?? "");
  const injectBase = base !== "" && base !== HOSTED_MCP_API_BASE;

  let out = template;
  // Base-URL placeholders, one per client env format. Blank when we're not
  // injecting so hosted snippets render exactly as before.
  out = out
    .split("{{BASE_URL_JSON}}")
    .join(injectBase ? `, "POSTWAVE_BASE_URL": "${base}"` : "");
  out = out
    .split("{{BASE_URL_BASH_FLAG}}")
    .join(injectBase ? ` -e POSTWAVE_BASE_URL=${base}` : "");
  out = out
    .split("{{BASE_URL_BASH_LINE}}")
    .join(injectBase ? `\nPOSTWAVE_BASE_URL=${base} \\` : "");

  if (!apiKey) return out;
  // Replace ALL key occurrences. A safe key character set (pw_ + hex)
  // means we don't need to escape, but use split/join anyway so a
  // pathological key with `$` in it can't trip the regex backref
  // grammar (`String.prototype.replaceAll` would also work but isn't
  // available pre-ES2021 in some build targets).
  return out.split("{{API_KEY}}").join(apiKey);
}
