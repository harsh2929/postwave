// SPDX-License-Identifier: AGPL-3.0-only
// Bounded local QA: Next otherwise gives its development worker half of the
// host's RAM. Its built-in 80% heap threshold can recycle the worker earlier
// with this explicit budget, rather than letting a long QA session exhaust
// the Mac. RSS also includes native buffers and can exceed the JS heap limit.
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { descendantRssKiB } from "./lib/qa-process-memory.mjs";

const require = createRequire(import.meta.url);
const start = () =>
  spawn(
    process.execPath,
    [
      require.resolve("next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3000",
      "--disable-source-maps",
      ...process.argv.slice(2),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=2048"]
          .filter(Boolean)
          .join(" "),
        NEXT_WEBPACK_PARALLELISM: "4",
        POSTWAVE_LOCAL_QA_MEMORY_MODE: "1",
        // The QA workspace is already seeded in the local database. Mixing
        // browser-only fixtures with real planner/report endpoints loses edits
        // on reload and makes the same campaign have two different identities.
        NEXT_PUBLIC_USE_MOCKS: "0",
      },
    },
  );

let child;
let stopping = false;
let recycling = false;
let probing = false;
let overBudgetSamples = 0;
let forceStop;
const restarts = [];
const rssBudgetKiB = 3584 * 1024;

function signalOwnedGroup(signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(error.message);
  }
}

function stopChild(signal = "SIGTERM") {
  signalOwnedGroup(signal);
  clearTimeout(forceStop);
  forceStop = setTimeout(() => signalOwnedGroup("SIGKILL"), 5000);
  forceStop.unref();
}

function launch() {
  child = start();
  child.once("error", (error) => {
    console.error("Could not start the local QA server:", error.message);
    stopping = true;
    clearInterval(memoryCheck);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    clearTimeout(forceStop);
    // The CLI and worker have their own process group. Reap any lingering
    // worker before reusing the port; never signal an unrelated app.
    signalOwnedGroup("SIGKILL");
    if (recycling && !stopping) {
      recycling = false;
      overBudgetSamples = 0;
      launch();
    } else {
      clearInterval(memoryCheck);
      process.exitCode = stopping ? (process.exitCode ?? 0) : (code ?? 1);
    }
  });
}

// Two consecutive samples avoid recycling for a short compilation spike.
// A capped restart window prevents a permanent large route from looping.
const memoryCheck = setInterval(() => {
  if (
    process.platform === "win32" ||
    probing ||
    stopping ||
    recycling ||
    !child?.pid
  )
    return;
  probing = true;
  const expectedChild = child;
  execFile(
    "ps",
    ["-axo", "pid=,ppid=,rss="],
    { timeout: 3000, maxBuffer: 1024 * 1024 },
    (error, output) => {
      probing = false;
      if (error || child !== expectedChild || stopping || recycling) return;
      const rss = descendantRssKiB(output, child.pid);
      overBudgetSamples = rss > rssBudgetKiB ? overBudgetSamples + 1 : 0;
      if (overBudgetSamples < 2) return;
      const now = Date.now();
      while (restarts.length && restarts[0] < now - 5 * 60_000)
        restarts.shift();
      if (restarts.length >= 3) {
        console.error(
          "[QA memory] Repeated memory growth; stopping the web server to protect the machine.",
        );
        stopping = true;
        process.exitCode = 1;
      } else {
        restarts.push(now);
        recycling = true;
        console.warn(
          `[QA memory] Web processes use ${Math.round(rss / 1024)} MiB; recycling the local QA server. Reload the current page after it is ready.`,
        );
      }
      stopChild();
    },
  );
}, 10_000);
memoryCheck.unref();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    stopChild(signal);
  });
}
launch();
