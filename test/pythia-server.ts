/**
 * Pythia NDJSON server — Phase 2 subprocess entrypoint.
 *
 * Spawned by the mock HexCore harness (or, eventually, by real HexCore). Wires
 * the OracleClient transport to a live Pythia instance and blocks until the
 * parent kills it.
 *
 * Protocol flow:
 *   1. Server creates OracleClient on stdio and registers decision/tool handlers.
 *   2. Server calls client.connect() which sends a handshake frame on stdout
 *      and awaits the peer's handshake on stdin.
 *   3. Every DecisionRequest frame from stdin is routed to Pythia.decide().
 *      Pythia's tool_use loop calls client.sendToolCall() for inspection tools;
 *      those emit ToolCall frames on stdout and await ToolResult on stdin.
 *   4. Pythia's final decision is serialized as a DecisionResponse frame and
 *      written on stdout.
 *   5. Session ends when the parent kills the subprocess (there's no clean
 *      shutdown path from the server side because OracleClient doesn't expose
 *      a session_end callback in v0.1).
 *
 * All logs go to stderr so stdout stays pure NDJSON.
 *
 * Usage (normally invoked by mock-hexcore.ts, but can run standalone):
 *   npx tsx test/pythia-server.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pythia } from "../src/agent/pythia.js";
import { OracleClient } from "../src/oracle/client.js";

// ─── Load .env (no dotenv dep) ────────────────────────────────────────────

function loadDotenv(filePath: string): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  loadDotenv(path.join(repoRoot, ".env"));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[pythia-server] ANTHROPIC_API_KEY not set; starting in REHEARSAL mode (deterministic stubs)");
  } else {
    console.error(`[pythia-server] live mode (key len=${apiKey.length})`);
  }

  const client = new OracleClient({
    transport: "stdio",
    pythiaVersion: "0.1.0-hackathon",
    capabilities: [
      "read_memory",
      "disassemble",
      "query_helix",
      "search_hql",
      "list_strings_near",
      "get_imports",
    ],
    logger: (m) => console.error(m),
  });

  const pythia = new Pythia({
    systemPromptPath: path.join(repoRoot, "prompts", "system.md"),
    ...(apiKey ? { apiKey } : {}),
    maxBudgetUsd: 1.0,
    onToolCall: (call) => client.sendToolCall(call),
    logger: (m) => console.error(m),
  });

  client.onDecisionRequest((req) => pythia.decide(req));

  // connect() sends our handshake out, then waits up to 5s for the peer's.
  try {
    const peerHandshake = await client.connect();
    console.error(
      `[pythia-server] handshake ok — peer=${peerHandshake.hexcoreVersion} protocol=${peerHandshake.protocolVersion}`
    );
  } catch (e) {
    console.error(`[pythia-server] handshake failed: ${(e as Error).message}`);
    process.exit(2);
  }

  // After handshake, we just sit and let the client's readline drive the loop.
  // The parent process terminates us when it's done.
  process.on("SIGTERM", () => {
    console.error(`[pythia-server] SIGTERM — final stats: ${JSON.stringify(pythia.getStats())}`);
    client.close();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    console.error(`[pythia-server] SIGINT — final stats: ${JSON.stringify(pythia.getStats())}`);
    client.close();
    process.exit(0);
  });

  // Keep alive.
  await new Promise(() => {
    /* block forever; parent signals exit */
  });
}

main().catch((e) => {
  console.error("[pythia-server] fatal:", e);
  process.exit(99);
});
