/**
 * Mock HexCore harness — Phase 2 end-to-end transport test.
 *
 * Simulates the HexCore side of the oracle protocol WITHOUT spinning up the
 * real emulator. Spawns the pythia-server subprocess, speaks NDJSON over its
 * stdio, validates that a fixture DecisionRequest round-trips cleanly into a
 * schema-valid DecisionResponse — including the tool_call / tool_result
 * inner loop.
 *
 * What this proves:
 *   - The OracleClient's stdio transport encodes and decodes frames correctly.
 *   - Frame boundaries (NDJSON) survive subprocess pipes.
 *   - Tool round-trips (tool_call → mock tool_result → resume loop) work.
 *   - The handshake protocol is two-way.
 *
 * What this does NOT prove:
 *   - Real HexCore integration (Phase 3).
 *   - SharedArrayBuffer transport (out of scope for hackathon).
 *
 * Usage:
 *   npx tsx test/mock-hexcore.ts                       (timing-check, default)
 *   npx tsx test/mock-hexcore.ts peb-access
 *   npx tsx test/mock-hexcore.ts api-hash
 *   npx tsx test/mock-hexcore.ts exception
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DecisionRequestSchema,
  DecisionResponseSchema,
  type DecisionResponse,
  type Handshake,
  type OracleMessage,
  type ToolCall,
  type ToolResult,
} from "../src/types/protocol.js";

const OVERALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

// ─── Fake tool handlers (mirror live-smoke defaults) ──────────────────────

function synthesizeToolResult(call: ToolCall): ToolResult {
  switch (call.tool) {
    case "read_memory": {
      const args = call.args;
      return {
        kind: "tool_result",
        eventId: call.eventId,
        callId: call.callId,
        ok: true,
        data: {
          address: args.address,
          bytes: "00".repeat(Math.min(args.length, 16)),
          note: "mock memory — zeroed",
        },
      };
    }
    case "disassemble":
      return {
        kind: "tool_result",
        eventId: call.eventId,
        callId: call.callId,
        ok: true,
        data: [
          { address: call.args.address, bytes: "90", mnemonic: "nop", operands: "" },
        ],
      };
    case "get_imports":
      return {
        kind: "tool_result",
        eventId: call.eventId,
        callId: call.callId,
        ok: true,
        data: {
          "kernel32.dll": ["QueryPerformanceCounter", "GetTickCount", "Sleep"],
          "user32.dll": ["MessageBoxA"],
        },
      };
    case "list_strings_near":
      return {
        kind: "tool_result",
        eventId: call.eventId,
        callId: call.callId,
        ok: true,
        data: [],
      };
    case "query_helix":
      return {
        kind: "tool_result",
        eventId: call.eventId,
        callId: call.callId,
        ok: true,
        data: { pseudoC: "/* mock: helix unavailable in mock-hexcore */", confidence: 0 },
      };
    case "search_hql":
      return {
        kind: "tool_result",
        eventId: call.eventId,
        callId: call.callId,
        ok: true,
        data: [],
      };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const scenario = process.argv[2] ?? "timing-check";

  const fixturePath = path.join(repoRoot, "test", "fixtures", `${scenario}.json`);
  const rawFixture = readFileSync(fixturePath, "utf8");
  const request = DecisionRequestSchema.parse(JSON.parse(rawFixture));
  console.error(`[mock] loaded fixture: ${scenario} (trigger=${request.trigger.kind})`);

  // Spawn the server. stdio: [pipe, pipe, inherit] — we control stdin+stdout,
  // child's stderr flows through to our terminal for visibility.
  const serverPath = path.join(repoRoot, "test", "pythia-server.ts");
  const child = spawn("npx", ["tsx", serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    shell: process.platform === "win32",
  });

  // ── Frame buffer + reader ────────────────────────────────────────────
  let buf = "";
  const incoming: Array<(msg: OracleMessage) => void> = [];
  let pendingResolveHandshake: ((h: Handshake) => void) | null = null;
  let pendingResolveDecision: ((r: DecisionResponse) => void) | null = null;

  const send = (msg: OracleMessage): void => {
    const frame = JSON.stringify(msg) + "\n";
    child.stdin.write(frame);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed: OracleMessage;
      try {
        parsed = JSON.parse(line) as OracleMessage;
      } catch (e) {
        console.error(`[mock] malformed frame from server: ${line.slice(0, 80)}`);
        continue;
      }
      console.error(`[mock] <-- ${parsed.kind}${"tool" in parsed ? ` (${(parsed as ToolCall).tool})` : ""}`);

      // Dispatch.
      if (parsed.kind === "handshake" && pendingResolveHandshake) {
        pendingResolveHandshake(parsed);
        pendingResolveHandshake = null;
      } else if (parsed.kind === "tool_call") {
        const result = synthesizeToolResult(parsed as ToolCall);
        console.error(`[mock] --> tool_result (ok=${result.ok})`);
        send(result);
      } else if (parsed.kind === "decision_response" && pendingResolveDecision) {
        pendingResolveDecision(parsed as DecisionResponse);
        pendingResolveDecision = null;
      } else {
        console.error(`[mock] unhandled inbound: ${parsed.kind}`);
      }
    }
  });

  child.on("exit", (code, signal) => {
    console.error(`[mock] server exit code=${code} signal=${signal}`);
  });

  // ── Timeouts ────────────────────────────────────────────────────────
  const overallTimeout = setTimeout(() => {
    console.error(`[mock] OVERALL_TIMEOUT_MS (${OVERALL_TIMEOUT_MS}ms) exceeded; killing server`);
    child.kill();
    process.exit(10);
  }, OVERALL_TIMEOUT_MS);
  overallTimeout.unref();

  // ── 1. Handshake: wait for server's outbound handshake, then reply ──
  const peerHandshake = await new Promise<Handshake>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server handshake timeout")), HANDSHAKE_TIMEOUT_MS);
    t.unref();
    pendingResolveHandshake = (h) => {
      clearTimeout(t);
      resolve(h);
    };
  });
  console.error(
    `[mock] server handshake ok — pythia=${peerHandshake.pythiaVersion} capabilities=[${peerHandshake.capabilities.length}]`
  );

  console.error(`[mock] --> handshake`);
  send({
    kind: "handshake",
    protocolVersion: 1,
    hexcoreVersion: "3.8.0-mock",
    pythiaVersion: peerHandshake.pythiaVersion,
    capabilities: peerHandshake.capabilities,
  });

  // ── 2. Send decision_request, await decision_response ───────────────
  const t0 = Date.now();
  console.error(`[mock] --> decision_request (eventId=${request.eventId})`);
  const decisionPromise = new Promise<DecisionResponse>((resolve) => {
    pendingResolveDecision = resolve;
  });
  send(request);

  const response = await decisionPromise;
  const elapsedMs = Date.now() - t0;
  console.error(`[mock] round-trip complete in ${elapsedMs}ms`);

  // ── 3. Validate response ─────────────────────────────────────────────
  const parsed = DecisionResponseSchema.safeParse(response);
  if (!parsed.success) {
    console.error(`[mock] ❌ decision_response FAILED schema:\n${parsed.error.message}`);
    child.kill();
    process.exit(3);
  }
  if (response.eventId !== request.eventId) {
    console.error(`[mock] ❌ eventId mismatch (req=${request.eventId} resp=${response.eventId})`);
    child.kill();
    process.exit(4);
  }

  console.log("─── decision_response ───");
  console.log(JSON.stringify(response, null, 2));
  console.error(`[mock] ✅ transport round-trip passed for '${scenario}' (${elapsedMs}ms)`);

  // ── 4. Tear down ──────────────────────────────────────────────────────
  // Give stderr a moment to flush the server's final stats log.
  setTimeout(() => {
    child.kill();
    process.exit(0);
  }, 500);
}

main().catch((e) => {
  console.error("[mock] fatal:", e);
  process.exit(99);
});
