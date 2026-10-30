/**
 * main.tsx — boots the audit-portal SPA. It synchronously captures and
 * removes the fragment-only one-time bootstrap before React, telemetry, or
 * application network I/O can start, then hands the credential to <App />.
 */
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { consumePortalBootstrap } from "./lib/bootstrap";

const root = document.getElementById("root");
if (!root) throw new Error("audit-portal: #root missing from index.html");
const bootstrap = consumePortalBootstrap();

// The bootstrap exchange is intentionally a one-shot side effect. React's
// development StrictMode replays effects and would race the credential
// against itself, so this tiny portal mounts once just as it does in
// production.
createRoot(root).render(<App bootstrap={bootstrap} />);
