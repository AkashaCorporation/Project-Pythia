/**
 * Phase 1 live smoke test — first real Claude call against a fixture.
 *
 * Loads ANTHROPIC_API_KEY from .env (native fs read), constructs Pythia in
 * live mode, runs decide() against the timing-check fixture, validates the
 * response shape, and prints cost + stats. Caps budget at $1.00 so any
 * runaway tool loop dies cheap.
 *
 * Usage:
 *   npx tsx test/live-smoke.ts                       (timing-check, default)
 *   npx tsx test/live-smoke.ts peb-access
 *   npx tsx test/live-smoke.ts api-hash
 *   npx tsx test/live-smoke.ts exception
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { Pythia } from "../src/agent/pythia.js";
import {
  DecisionRequestSchema,
  DecisionResponseSchema,
  type ToolCall,
  type ToolResult,
} from "../src/types/protocol.js";

// ─── Load .env manually (no dotenv dep) ──────────────────────────────────

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

// ─── Mock onToolCall — returns minimal plausible data for each tool ──────

function makeMockToolCall() {
  let callCount = 0;
  return async (
    call: Omit<ToolCall, "kind" | "callId">
  ): Promise<ToolResult> => {
    callCount++;
    const callId = `smoke-${callCount}`;
    switch (call.tool) {
      case "read_memory": {
        const args = call.args as { address: string; length: number };
        return {
          kind: "tool_result",
          eventId: call.eventId,
          callId,
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
          callId,
          ok: true,
          data: [
            { address: (call.args as { address: string }).address, bytes: "90", mnemonic: "nop", operands: "" },
          ],
        };
      case "get_imports":
        return {
          kind: "tool_result",
          eventId: call.eventId,
          callId,
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
          callId,
          ok: true,
          data: [],
        };
      case "query_helix":
        return {
          kind: "tool_result",
          eventId: call.eventId,
          callId,
          ok: true,
          data: { pseudoC: "/* mock: helix unavailable in smoke test */", confidence: 0 },
        };
      case "search_hql":
        return {
          kind: "tool_result",
          eventId: call.eventId,
          callId,
          ok: true,
          data: [],
        };
      default:
        return {
          kind: "tool_result",
          eventId: call.eventId,
          callId,
          ok: false,
          error: `mock has no handler for tool '${call.tool as string}'`,
        };
    }
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  loadDotenv(path.join(repoRoot, ".env"));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[smoke] ANTHROPIC_API_KEY not set (checked .env + process.env). aborting.");
    process.exit(1);
  }
  console.error(`[smoke] api key detected: ${apiKey.slice(0, 12)}...${apiKey.slice(-4)} (len=${apiKey.length})`);

  const scenario = process.argv[2] ?? "timing-check";
  const fixturePath = path.join(repoRoot, "test", "fixtures", `${scenario}.json`);
  const raw = readFileSync(fixturePath, "utf8");
  const parsedUnknown = JSON.parse(raw);
  const requestParse = DecisionRequestSchema.safeParse(parsedUnknown);
  if (!requestParse.success) {
    console.error(`[smoke] fixture ${scenario} failed schema validation:`);
    console.error(requestParse.error.message);
    process.exit(2);
  }
  const request = requestParse.data;
  console.error(`[smoke] fixture loaded: ${scenario} (trigger=${request.trigger.kind}, rip=${request.context.registers.rip})`);

  const pythia = new Pythia({
    systemPromptPath: path.join(repoRoot, "prompts", "system.md"),
    apiKey,
    maxBudgetUsd: 1.0,
    onToolCall: makeMockToolCall(),
    logger: (m) => console.error(m),
  });

  const t0 = Date.now();
  const response = await pythia.decide(request);
  const elapsedMs = Date.now() - t0;

  const responseParse = DecisionResponseSchema.safeParse(response);
  if (!responseParse.success) {
    console.error("[smoke] response FAILED DecisionResponseSchema:");
    console.error(responseParse.error.message);
    console.error("raw response:");
    console.error(JSON.stringify(response, null, 2));
    process.exit(3);
  }

  console.log("─── response ───");
  console.log(JSON.stringify(response, null, 2));
  console.error(`─── stats ───`);
  console.error(`elapsed: ${elapsedMs}ms`);
  console.error(`pythia stats: ${JSON.stringify(pythia.getStats(), null, 2)}`);

  if (response.eventId !== request.eventId) {
    console.error(`[smoke] WARN: eventId mismatch (req=${request.eventId} resp=${response.eventId})`);
    process.exit(4);
  }
  console.error(`[smoke] ✅ phase 1 smoke passed for scenario '${scenario}'`);
}

main().catch((e) => {
  console.error("[smoke] fatal:", e);
  process.exit(99);
});
