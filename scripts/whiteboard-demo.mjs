#!/usr/bin/env node

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = fileURLToPath(import.meta.url);
const appRoot = join(repoRoot, "apps", "whiteboard");
const runtimeDir = join(repoRoot, ".whiteboard-demo");
const statePath = join(runtimeDir, "state.json");
const stateTempPath = join(runtimeDir, "state.tmp.json");
const logPath = join(runtimeDir, "demo.log");
const startLockPath = join(runtimeDir, "start.lock");
const defaultAppPort = 5_199;
const controlHost = "127.0.0.1";
const startTimeoutMs = 120_000;
const stopTimeoutMs = 15_000;
const controlTimeoutMs = 1_000;

class CommandError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function configuredAppPort() {
  const source = process.env.WHITEBOARD_DEMO_PORT ?? String(defaultAppPort);
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CommandError(`WHITEBOARD_DEMO_PORT must be an integer from 1 through 65535; received ${source}.`, 2);
  }
  return port;
}

function publicAppUrl(port) {
  return `http://localhost:${port}/`;
}

function viteCliPath() {
  const requireFromApp = createRequire(join(appRoot, "package.json"));
  return join(dirname(requireFromApp.resolve("vite/package.json")), "bin", "vite.js");
}

function ensureRuntimeDir() {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
}

function randomId() {
  return randomBytes(24).toString("hex");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function unrefDelay(milliseconds, value) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(value), milliseconds);
    timer.unref();
  });
}

function pnpmCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /(?:^|[/\\])pnpm\.(?:c?js)$/i.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (npmExecPath && /(?:^|[/\\])pnpm(?:\.cmd|\.exe)?$/i.test(npmExecPath)) {
    return { command: npmExecPath, args };
  }
  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    args,
  };
}

async function runPnpm(args) {
  const invocation = pnpmCommand(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });

  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);

  try {
    const result = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    });
    if (result.signal) throw new CommandError(`pnpm was terminated by ${result.signal}.`, 1);
    if (result.code !== 0) throw new CommandError(`pnpm exited with code ${result.code}.`, result.code ?? 1);
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
}

function readState() {
  if (!existsSync(statePath)) return { kind: "missing" };
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (
      state?.version !== 1 ||
      typeof state.instanceId !== "string" ||
      typeof state.token !== "string" ||
      !Number.isInteger(state.managerPid) ||
      !Number.isInteger(state.appPort) ||
      state.appPort < 1 ||
      state.appPort > 65_535 ||
      state.url !== publicAppUrl(state.appPort) ||
      !Number.isInteger(state.controlPort) ||
      state.controlPort < 1 ||
      state.controlPort > 65_535
    ) {
      return { kind: "invalid", reason: "invalid metadata" };
    }
    return { kind: "valid", state };
  } catch (error) {
    return { kind: "invalid", reason: `unreadable metadata: ${error.message}` };
  }
}

function writeState(state) {
  ensureRuntimeDir();
  writeFileSync(stateTempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(stateTempPath, statePath);
}

function removeOwnedState(instanceId) {
  const current = readState();
  if (current.kind === "valid" && current.state.instanceId === instanceId) {
    rmSync(statePath, { force: true });
  }
  rmSync(stateTempPath, { force: true });
}

function requestControl(state, method, pathname) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        host: controlHost,
        port: state.controlPort,
        method,
        path: pathname,
        headers: { "x-whiteboard-demo-token": state.token },
        timeout: controlTimeoutMs,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          let payload;
          try {
            payload = body ? JSON.parse(body) : {};
          } catch {
            rejectPromise(new Error(`control server returned invalid JSON (${response.statusCode})`));
            return;
          }
          if ((response.statusCode ?? 500) >= 400) {
            rejectPromise(new Error(payload.error || `control server returned ${response.statusCode}`));
            return;
          }
          resolvePromise(payload);
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("control server timed out")));
    request.once("error", rejectPromise);
    request.end();
  });
}

async function inspectController(state) {
  try {
    const status = await requestControl(state, "GET", "/status");
    if (
      status.instanceId !== state.instanceId ||
      status.managerPid !== state.managerPid ||
      status.appPort !== state.appPort ||
      status.url !== state.url
    ) {
      return { live: false, reason: "runtime identity mismatch" };
    }
    return { live: true, status };
  } catch (error) {
    return { live: false, reason: error.message };
  }
}

function checkReadiness(port, timeoutMs = 1_000) {
  return new Promise((resolvePromise) => {
    const request = httpRequest(publicAppUrl(port), { method: "GET", timeout: timeoutMs }, (response) => {
      response.resume();
      resolvePromise((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 400);
    });
    request.once("timeout", () => {
      request.destroy();
      resolvePromise(false);
    });
    request.once("error", () => resolvePromise(false));
    request.end();
  });
}

function logTail(maxBytes = 16_384) {
  if (!existsSync(logPath)) return "";
  const size = statSync(logPath).size;
  const length = Math.min(size, maxBytes);
  if (length === 0) return "";
  const descriptor = openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8").trim();
  } finally {
    closeSync(descriptor);
  }
}

function withLog(message) {
  const tail = logTail();
  const location = relative(repoRoot, logPath);
  return tail ? `${message}\nLog (${location}):\n${tail}` : `${message}\nSee ${location}.`;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireStartLock(instanceId) {
  ensureRuntimeDir();
  try {
    const descriptor = openSync(startLockPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ instanceId, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    closeSync(descriptor);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let stale = true;
  try {
    const lock = JSON.parse(readFileSync(startLockPath, "utf8"));
    stale = !Number.isInteger(lock.pid) || !processExists(lock.pid);
  } catch {
    stale = true;
  }
  if (!stale) throw new CommandError("Another whiteboard demo start is already in progress.");

  rmSync(startLockPath, { force: true });
  const descriptor = openSync(startLockPath, "wx", 0o600);
  writeFileSync(descriptor, `${JSON.stringify({ instanceId, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  closeSync(descriptor);
}

function releaseStartLock(instanceId) {
  try {
    const lock = JSON.parse(readFileSync(startLockPath, "utf8"));
    if (lock.instanceId === instanceId) rmSync(startLockPath, { force: true });
  } catch {
    // A missing or replaced lock is not ours to remove.
  }
}

async function waitForReady(expectedInstanceId, managerProcess) {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    const current = readState();
    if (current.kind === "valid" && current.state.instanceId === expectedInstanceId) {
      if (current.state.phase === "failed") {
        throw new CommandError(withLog("The whiteboard demo process exited during startup."));
      }
      const controller = await inspectController(current.state);
      if (
        controller.live &&
        controller.status.phase === "ready" &&
        (await checkReadiness(current.state.appPort))
      ) {
        return controller.status;
      }
    }
    if (!processExists(managerProcess.pid)) {
      throw new CommandError(withLog("The whiteboard demo manager exited during startup."));
    }
    await sleep(250);
  }
  throw new CommandError(withLog(`The whiteboard demo was not ready within ${startTimeoutMs / 1_000} seconds.`));
}

async function stopOwnedManager(expectedInstanceId, managerProcess) {
  const current = readState();
  if (current.kind === "valid" && current.state.instanceId === expectedInstanceId) {
    const controller = await inspectController(current.state);
    if (controller.live) {
      try {
        await requestControl(current.state, "POST", "/stop");
        return;
      } catch {
        // Fall through to signaling the manager process that this invocation created.
      }
    }
  }
  if (managerProcess.exitCode === null && managerProcess.signalCode === null) {
    managerProcess.kill("SIGTERM");
  }
}

async function buildDemo() {
  console.log("Building the whiteboard demo with the project pnpm scripts...");
  await runPnpm(["run", "build"]);
  console.log("Whiteboard demo build completed.");
}

async function startDemo() {
  configuredAppPort();
  ensureRuntimeDir();
  const existing = readState();
  if (existing.kind === "valid") {
    const controller = await inspectController(existing.state);
    if (controller.live) {
      if (controller.status.phase !== "ready" || !(await checkReadiness(existing.state.appPort))) {
        throw new CommandError(
          `Whiteboard demo manager is ${controller.status.phase}; inspect ${relative(repoRoot, logPath)} and retry.`,
        );
      }
      console.log(`Whiteboard demo is already running at ${existing.state.url}`);
      console.log(`Log: ${relative(repoRoot, logPath)}`);
      return;
    }
    rmSync(statePath, { force: true });
    console.log(`Removed stale whiteboard demo state (${controller.reason}).`);
  } else if (existing.kind === "invalid") {
    rmSync(statePath, { force: true });
    console.log(`Removed stale whiteboard demo state (${existing.reason}).`);
  }

  const instanceId = randomId();
  const token = randomId();
  let managerProcess;
  acquireStartLock(instanceId);

  try {
    console.log("Building the required Wasm bridge with the project pnpm script...");
    await runPnpm(["run", "build:wasm"]);
    viteCliPath();
    writeFileSync(logPath, "", { mode: 0o600 });

    managerProcess = spawn(process.execPath, [scriptPath, "__serve"], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        WHITEBOARD_DEMO_INSTANCE_ID: instanceId,
        WHITEBOARD_DEMO_TOKEN: token,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    managerProcess.unref();

    const status = await waitForReady(instanceId, managerProcess);
    console.log(`Whiteboard demo is ready at ${status.url}`);
    console.log(`Manager PID: ${status.managerPid}; server PID: ${status.childPid}`);
    console.log(`Log: ${relative(repoRoot, logPath)}`);
  } catch (error) {
    if (managerProcess) await stopOwnedManager(instanceId, managerProcess);
    throw error;
  } finally {
    releaseStartLock(instanceId);
  }
}

async function statusDemo() {
  const current = readState();
  if (current.kind === "missing") {
    console.log("Whiteboard demo is stopped.");
    return 1;
  }
  if (current.kind === "invalid") {
    rmSync(statePath, { force: true });
    console.log(`Whiteboard demo is stopped; removed stale state (${current.reason}).`);
    return 1;
  }

  const controller = await inspectController(current.state);
  if (!controller.live) {
    rmSync(statePath, { force: true });
    console.log(`Whiteboard demo is stopped; removed stale state (${controller.reason}).`);
    return 1;
  }

  const ready = controller.status.phase === "ready" && (await checkReadiness(current.state.appPort));
  console.log(`Whiteboard demo is ${ready ? "running" : controller.status.phase}.`);
  console.log(`URL: ${controller.status.url}`);
  console.log(`Manager PID: ${controller.status.managerPid}; server PID: ${controller.status.childPid}`);
  console.log(`Started: ${controller.status.startedAt}`);
  console.log(`Log: ${relative(repoRoot, logPath)}`);
  return ready ? 0 : 1;
}

async function stopDemo() {
  const current = readState();
  if (current.kind === "missing") {
    console.log("Whiteboard demo is already stopped.");
    return;
  }
  if (current.kind === "invalid") {
    rmSync(statePath, { force: true });
    console.log(`Whiteboard demo is already stopped; removed stale state (${current.reason}).`);
    return;
  }

  const controller = await inspectController(current.state);
  if (!controller.live) {
    rmSync(statePath, { force: true });
    console.log(`Whiteboard demo is already stopped; removed stale state (${controller.reason}).`);
    return;
  }

  await requestControl(current.state, "POST", "/stop");
  const deadline = Date.now() + stopTimeoutMs;
  while (Date.now() < deadline) {
    const next = readState();
    if (next.kind === "missing") {
      if (processExists(current.state.managerPid)) {
        await sleep(100);
        continue;
      }
      console.log("Whiteboard demo stopped.");
      return;
    }
    if (next.kind !== "valid" || next.state.instanceId !== current.state.instanceId) {
      throw new CommandError("Whiteboard demo runtime state changed while stopping; refusing to remove it.");
    }
    const nextController = await inspectController(next.state);
    if (!nextController.live) {
      removeOwnedState(current.state.instanceId);
      if (!processExists(current.state.managerPid)) {
        console.log("Whiteboard demo stopped.");
        return;
      }
    }
    await sleep(200);
  }
  throw new CommandError(withLog(`Whiteboard demo did not stop within ${stopTimeoutMs / 1_000} seconds.`));
}

async function terminateChildTree(child) {
  if (!child || (child.exitCode !== null || child.signalCode !== null)) return;

  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return;
  }

  const exitPromise = new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true)));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return;
  }

  const exited = await Promise.race([exitPromise, unrefDelay(5_000, false)]);
  if (!exited) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

async function serveDemo() {
  const instanceId = process.env.WHITEBOARD_DEMO_INSTANCE_ID;
  const token = process.env.WHITEBOARD_DEMO_TOKEN;
  if (!instanceId || !token) throw new CommandError("Missing internal whiteboard demo runtime identity.", 2);
  const appPort = configuredAppPort();
  const appUrl = publicAppUrl(appPort);

  ensureRuntimeDir();
  const logDescriptor = openSync(logPath, "a", 0o600);
  const log = (message) => {
    appendFileSync(logDescriptor, `[whiteboard-demo ${new Date().toISOString()}] ${message}\n`);
  };

  let phase = "starting";
  let shuttingDown = false;
  let childExitCode = null;
  let childExitSignal = null;
  let readinessTimer;
  let child;
  let controlPort;
  const startedAt = new Date().toISOString();

  const metadata = () => ({
    version: 1,
    instanceId,
    token,
    managerPid: process.pid,
    childPid: child?.pid ?? null,
    appPort,
    controlPort,
    url: appUrl,
    phase,
    startedAt,
    childExitCode,
    childExitSignal,
  });

  const controlServer = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers["x-whiteboard-demo-token"] !== token) {
      response.statusCode = 403;
      response.end(`${JSON.stringify({ error: "forbidden" })}\n`);
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      response.end(`${JSON.stringify(metadata())}\n`);
      return;
    }
    if (request.method === "POST" && request.url === "/stop") {
      response.statusCode = 202;
      response.end(`${JSON.stringify({ stopping: true })}\n`);
      setImmediate(() => void shutdown("stop requested"));
      return;
    }
    response.statusCode = 404;
    response.end(`${JSON.stringify({ error: "not found" })}\n`);
  });

  const closeControlServer = () =>
    new Promise((resolvePromise) => {
      if (!controlServer.listening) {
        resolvePromise();
        return;
      }
      controlServer.close(() => resolvePromise());
    });

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    phase = "stopping";
    clearInterval(readinessTimer);
    log(`Stopping (${reason}).`);
    try {
      writeState(metadata());
      await terminateChildTree(child);
      await closeControlServer();
      removeOwnedState(instanceId);
      log("Stopped.");
      closeSync(logDescriptor);
      process.exitCode = 0;
    } catch (error) {
      log(`Stop failed: ${error.stack || error.message}`);
      process.exitCode = 1;
      await closeControlServer();
      closeSync(logDescriptor);
    }
  };

  await new Promise((resolvePromise, rejectPromise) => {
    controlServer.once("error", rejectPromise);
    controlServer.listen(0, controlHost, () => {
      controlServer.removeListener("error", rejectPromise);
      controlPort = controlServer.address().port;
      resolvePromise();
    });
  });

  child = spawn(process.execPath, [viteCliPath()], {
    cwd: appRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", logDescriptor, logDescriptor],
    windowsHide: true,
  });
  log(`Started the project Vite CLI as PID ${child.pid ?? "unknown"}.`);
  writeState(metadata());

  const fail = async (message, error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    phase = "failed";
    clearInterval(readinessTimer);
    log(`${message}${error ? `: ${error.stack || error.message}` : "."}`);
    writeState(metadata());
    await closeControlServer();
    closeSync(logDescriptor);
    process.exitCode = childExitCode || 1;
  };

  child.once("error", (error) => void fail("Could not start the project Vite CLI", error));
  child.once("exit", (code, signal) => {
    childExitCode = code;
    childExitSignal = signal;
    if (!shuttingDown) void fail(`Vite exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
  });

  readinessTimer = setInterval(async () => {
    if (phase !== "starting" || shuttingDown) return;
    if (await checkReadiness(appPort)) {
      phase = "ready";
      writeState(metadata());
      log(`Ready at ${appUrl}`);
      clearInterval(readinessTimer);
    }
  }, 250);
  readinessTimer.unref();

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  if (process.platform !== "win32") process.once("SIGHUP", () => void shutdown("SIGHUP"));
  process.once("uncaughtException", (error) => void shutdown(`uncaught exception: ${error.message}`));
  process.once("unhandledRejection", (error) =>
    void shutdown(`unhandled rejection: ${error instanceof Error ? error.message : String(error)}`),
  );
}

function usage() {
  console.log(`Usage: node scripts/whiteboard-demo.mjs <command>\n\nCommands:\n  build   Build the Wasm bridge and whiteboard application\n  start   Start the Vite whiteboard detached and wait until it is ready\n  status  Report runtime identity, health, URL, and log location\n  stop    Stop only the managed whiteboard process tree`);
}

async function main() {
  const [command, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0) throw new CommandError("Unexpected arguments.", 2);

  if (command === "__serve") {
    await serveDemo();
    return;
  }
  if (command === "build") {
    await buildDemo();
    return;
  }
  if (command === "start") {
    await startDemo();
    return;
  }
  if (command === "status") {
    process.exitCode = await statusDemo();
    return;
  }
  if (command === "stop") {
    await stopDemo();
    return;
  }
  usage();
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    throw new CommandError(`Unknown command: ${command}`, 2);
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = error.exitCode ?? 1;
}
