#!/usr/bin/env node
/**
 * Pythia CLI — entrypoint for running the agent against a HexCore session.
 *
 * Usage:
 *   pythia attach --session <id>                  Attach to a running session
 *   pythia drive  --sample <path/to/exe>          Spawn HexCore headlessly + drive
 *   pythia rehearse --scenario timing-check       Offline rehearsal (no API)
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pythia } from "./agent/pythia.js";
import type { ToolCall, ToolResult } from "./types/protocol.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  switch (command) {
    case "rehearse": {
      const scenario = args[args.indexOf("--scenario") + 1] ?? "timing-check";
      await rehearse(scenario);
      return;
    }
    case "attach":
    case "drive": {
      console.error(`[pythia] '${command}' requires live oracle — land phase 2 first.`);
      process.exit(2);
      return;
    }
    case "help":
    case "--help":
    case "-h":
    default:
      console.log("pythia — Oracle agent for HexCore emulation");
      console.log("");
      console.log("Commands:");
      console.log("  pythia rehearse --scenario <name>   Run offline against a fixture");
      console.log("  pythia attach   --session <id>      Attach to a live HexCore session");
      console.log("  pythia drive    --sample <path>     Spawn HexCore + drive end-to-end");
      console.log("");
      console.log("Scenarios (rehearse):");
      console.log("  timing-check    QPC-based anti-debug");
      console.log("  peb-access      gs:[60] PEB read");
      console.log("  api-hash        FNV-1a resolved API call");
      console.log("  exception       Emulator exception handling");
      return;
  }
}

async function rehearse(scenario: string) {
  const fixturePath = path.resolve(process.cwd(), "test/fixtures", `${scenario}.json`);
  const raw = await readFile(fixturePath, "utf8").catch(() => null);
  if (!raw) {
    console.error(`[pythia] no fixture at ${fixturePath}`);
    process.exit(1);
  }

  const request = JSON.parse(raw);
  const systemPromptPath = path.resolve(process.cwd(), "prompts/system.md");

  // PythiaConfig.onToolCall receives the call without `kind`/`callId` — those
  // are assigned by the oracle client at send time. The rehearsal mock fills
  // a synthetic callId so the ToolResult shape stays well-formed, even though
  // in rehearsal mode the mock is never actually invoked (no live API = no
  // tool_use blocks to dispatch).
  const mockToolCall = async (
    call: Omit<ToolCall, "kind" | "callId">
  ): Promise<ToolResult> => ({
    kind: "tool_result",
    eventId: call.eventId,
    callId: `mock-${Math.random().toString(36).slice(2, 10)}`,
    ok: true,
    data: { mock: true, tool: call.tool },
  });

  const pythia = new Pythia({
    systemPromptPath,
    maxBudgetUsd: 10,
    onToolCall: mockToolCall,
  });

  const response = await pythia.decide(request);
  console.log(JSON.stringify(response, null, 2));
  console.error(`[pythia] stats: ${JSON.stringify(pythia.getStats())}`);
}

main().catch(err => {
  console.error("[pythia] fatal:", err);
  process.exit(1);
});
