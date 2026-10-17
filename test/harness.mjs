// MCP test harness (launch content OS ticket 01).
//
// One local dev server on a throwaway Postgres database, driven over MCP the
// way Hermes drives it. Nothing paid can run: every paid key is blanked and
// both daily caps are 0, so a paid tool is refused before it reaches a
// provider. Tests may seed state with sql() where the only real route would
// be a paid call (an adaptation result, a finished video).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.TEST_PORT ?? 3990);
export const BASE = `http://localhost:${PORT}`;
// run.mjs makes these once and hands them to each test file's process
// through the environment.
export const TOKEN = (process.env.HARNESS_TOKEN ??= randomBytes(16).toString("hex"));
export const REELS_DIR = (process.env.HARNESS_REELS_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "viral-test-reels-")));

// The test database lives on the same local server as DATABASE_URL (from the
// environment or .env.local), under a fresh name. Refuses any non-local host
// so a test run can never create or drop a database on Railway.
function adminUrl() {
  let url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    const env = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
    url = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
  }
  if (!url) throw new Error("Set TEST_DATABASE_URL (or DATABASE_URL in .env.local) to a local Postgres.");
  const u = new URL(url);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) {
    throw new Error(`Refusing to run tests against non-local Postgres host ${u.hostname}.`);
  }
  return u;
}

const admin = adminUrl();
const DB_NAME = (process.env.HARNESS_DB ??= `viral_test_${Date.now()}`);
const testUrl = new URL(admin);
testUrl.pathname = `/${DB_NAME}`;

let server;
let pool;
// allowExitOnIdle: an idle pool must not keep a test file's process alive.
const db = () => (pool ??= new pg.Pool({ connectionString: testUrl.toString(), allowExitOnIdle: true }));

async function withAdmin(fn) {
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function start() {
  await withAdmin((c) => c.query(`CREATE DATABASE ${DB_NAME}`));
  server = spawn(path.join(ROOT, "node_modules/.bin/next"), ["dev", "-p", String(PORT)], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NEXT_DIST_DIR: ".next-test",
      DATABASE_URL: testUrl.toString(),
      MCP_API_TOKEN: TOKEN,
      MCP_DAILY_PAID_CALL_CAP: "0",
      MCP_DAILY_SCAN_CAP: "0",
      // Present but empty: Next does not overwrite a set variable from .env.local.
      ANTHROPIC_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      TREG_TOKEN: "",
      APP_PASSWORD: "",
      REELS_OUTPUT_DIR: REELS_DIR,
      PUBLIC_BASE_URL: BASE,
    },
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/mcp`, { method: "POST" });
      if (res.status === 401) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Test server did not come up on ${BASE}:\n${log.slice(-2000)}`);
}

export async function stop() {
  if (server) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await pool?.end();
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
  fs.rmSync(REELS_DIR, { recursive: true, force: true });
}

export async function sql(text, params = []) {
  const { rows } = await db().query(text, params);
  return rows;
}

// An MCP client authenticated the way Hermes is. Stateless server, so one
// client per test file is fine; close it in after() so the file's process
// can exit.
export async function connect(token = TOKEN) {
  const client = new Client({ name: "harness", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

// Calls a tool and returns {ok, data, error}: data is the parsed JSON result,
// error the operator-readable message of a refused or failed call.
export async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { ok: false, error: text };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
}

// Audit rows for one tool, oldest first.
export const audits = (tool) =>
  sql("SELECT tool, reel_id, ok, error, rationale, args FROM agent_actions WHERE tool = $1 ORDER BY id", [tool]);

// A free original reel, accepted at Script (add_original), for tests that
// need an item to work on.
export async function original(client, extra = {}) {
  const r = await call(client, "add_original", {
    brand: "nuronomics",
    script: `Test original ${randomBytes(4).toString("hex")}. Mark the pages you stumble on.`,
    rationale: "harness fixture",
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

// Moves a reel straight to a status, standing in for paid steps (adaptation,
// voiceover, burn) the tests must not run.
export async function forceStatus(id, status, fields = {}) {
  const sets = ["status = $2", ...Object.keys(fields).map((k, i) => `${k} = $${i + 3}`)];
  await sql(`UPDATE reels SET ${sets.join(", ")} WHERE id = $1`, [id, status, ...Object.values(fields)]);
}
