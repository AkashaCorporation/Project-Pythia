# [Roadmap] Project Pythia — implementing this issue for the Anthropic Claude hackathon (Apr 21-26 2026)

> This comment is a living roadmap. If you're a Claude instance that was just pointed at this issue to continue the work: read all of it, then go to the repo linked below and read `HANDOFF.md` in full before taking any action.

Hi @YasminePayload — the Oracle Hook you proposed back in March is finally happening. I'm implementing it for the **[Anthropic Claude Developer Hackathon](https://www.anthropic.com/)** this week under the name **Project Pythia**, and this issue is the anchor.

## Background

- Issue #17 proposed a pause-and-respond callback system that lets an external agent intervene during `emulateFullHeadless` — the foundational primitive for autonomous RE.
- The original acceptance comment tracked this for v4.0+ with a dependency on #31 (Zero-Copy IPC Shared Memory).
- **#31 is effectively satisfied.** Project Perseus shipped in HexCore v3.8.0 as part of `hexcore-unicorn` 1.3.0 — SharedArrayBuffer zero-copy hook delivery, 1.34× throughput. The IPC substrate the Oracle Hook needs is already on `main`.
- That means Oracle Hook is now a buildable v3.9.0 feature, and the hackathon week is enough time for the MVP + demo.

## Project structure

Two repositories, two branches:

| Where | What |
|---|---|
| `github.com/AkashaCorporation/Project-Pythia` (new repo) | **Pythia** — the Claude-powered agent that receives Decision Requests and issues Decisions. All code in this repo is 100% new, dated within the hackathon window. |
| `github.com/AkashaCorporation/HikariSystem-HexCore` branch `feature/oracle-hook-hackathon` (new branch) | **Oracle Hook** — the HexCore-side implementation. Trigger registry + pause/resume + SAB message protocol. Minimal diff (~50 LOC in C++, ~300 LOC in TypeScript). |

Pythia consumes HexCore as an open-source dependency — the same way the project uses Node.js or LLVM.

## Architecture (1-minute version)

```
HexCore emulation hits a trigger
  -> Oracle Hook pauses worker, captures registers/disasm/memory/callstack
  -> Serializes DecisionRequest, writes to SAB (or stdio NDJSON fallback)
  -> Pythia reads, feeds to Claude with inspection tools + system prompt
  -> Claude calls read_memory / disassemble / query_helix as needed
  -> Claude calls terminal tool `decide(action, patches?, skip?)`
  -> Pythia serializes DecisionResponse back to HexCore
  -> Oracle Hook applies patches, resumes worker
```

Full protocol spec: [`src/types/protocol.ts`](https://github.com/AkashaCorporation/Project-Pythia/blob/main/src/types/protocol.ts) in the Pythia repo.

## Decision contract

This addresses the Decision JSON contract you proposed. The hackathon implementation generalizes it slightly:

```typescript
type DecisionResponse = {
  kind: "decision_response";
  eventId: string;                              // echoes the request
  action: "continue" | "patch" | "skip" | "patch_and_skip" | "abort";
  patches?: Array<{
    target: "register" | "memory" | "flag";
    location: string;                           // rax..r15, address hex, zf/cf/...
    value: string;                              // hex or decimal
    size?: number;                              // bytes, for memory patches
  }>;
  skip?: {
    instructions?: number;
    untilAddress?: string;
  };
  reasoning?: string;                           // one short line, for traces
  modelUsed?: "haiku" | "sonnet" | "opus";
  costUsd?: number;
};
```

Differences from your original proposal:
- `patch` is an **array** (some bypasses need two patches — e.g. patch a register AND a flag).
- `patch_and_skip` added (common pattern: zero a return value then skip the check).
- `abort` added (for emulator exceptions / stuck states).
- Cost/model metadata so the session can enforce budget.

## Trigger types (day 1 scope)

| Kind | Day 1? | Notes |
|---|---|---|
| `instruction` | ✅ | Required; O(1) lookup via Set<bigint> |
| `api` | ✅ | Required; checked at IAT boundaries |
| `exception` | ✅ | Emulator fault fallthrough |
| `timing_check` | ⬜ | Heuristic — fires after QPC/KUSER/GetTickCount reads |
| `peb_access` | ⬜ | Heuristic — fires on gs:[60]/fs:[30] deref |
| `memory_read` / `memory_write` | ⬜ | Day 2+ |

## Phase breakdown

### Phase 0 — Scaffolding (done, Tuesday Apr 21)

- ✅ `Project-Pythia` repo bootstrapped
- ✅ Protocol types (Zod schemas) complete
- ✅ Pythia agent class with dual-mode decide() — rehearsal + live
- ✅ Oracle client (stdio NDJSON transport)
- ✅ Tool definitions for 8 tools (`read_memory`, `disassemble`, `query_helix`, `search_hql`, `list_strings_near`, `get_imports`, `run_pipeline_job`, `decide`)
- ✅ System prompt with Pythia persona + HexCore pipeline integration
- ✅ 4 rehearsal fixtures (timing-check, peb-access, api-hash, exception)
- ✅ HANDOFF.md for transition to hackathon account
- ✅ Model routing with budget enforcement (Haiku default, Sonnet on hard triggers, Opus on repeat-stuck sites)

### Phase 1 — Live validation (Wednesday Apr 22, half day)

- ⬜ `test/live-smoke.ts` — first real Claude call against `timing-check.json` fixture, verify DecisionResponse parses
- ⬜ Iterate on system prompt until Haiku consistently produces correct patches (target: 10/10 on fixtures)
- ⬜ Cost check — target <$0.01 per decision on Haiku

### Phase 2 — Transport (Wednesday Apr 22, rest of day)

- ⬜ `test/mock-hexcore.ts` — Node script simulating HexCore stdio frames
- ⬜ End-to-end round-trip: fixture → stdin → Pythia → Claude → tool calls (mocked) → decision → stdout
- ⬜ Validate tool result handling, error paths, timeout behavior

### Phase 3 — HexCore branch (Thursday Apr 23 - Friday Apr 24, ~1.5 days)

- ⬜ Branch `feature/oracle-hook-hackathon` from `v3.8.0`
- ⬜ `extensions/hexcore-unicorn/src/oracle-hook.ts` — trigger registry
- ⬜ `extensions/hexcore-unicorn/src/oracle-protocol.ts` — mirror of Pythia's protocol types
- ⬜ `extensions/hexcore-unicorn/src/oracle-transport.ts` — SAB + stdio encoder
- ⬜ `unicorn_wrapper.cpp` — ~50 LOC trigger check in hook loop
- ⬜ `extensions/hexcore-disassembler/src/oracleSession.ts` — public API
- ⬜ `extensions/hexcore-disassembler/src/oracleCommands.ts` — 3 new VS Code commands
- ⬜ `package.json` declarations + setting `hexcore.oracle.enabled`
- ⬜ Integration test spawning a mock Pythia-shaped responder

### Phase 4 — End-to-end demo (Saturday Apr 25)

The demo target is an inert dummy malware sample (`Malware HexCore Defeat v6.1 "Echo Mirage"`) that I built specifically to evade HexCore v3.8.0. The sample uses layered anti-debug, API hash resolution, and URL obfuscation. Baseline HexCore emulation trips the anti-debug and exits without observing the beacon.

- ⬜ Run v6.1 through `hexcore.debug.emulateFullHeadless` without Oracle — capture `"no malicious behavior observed"` baseline
- ⬜ Run same binary with `--oracle pythia` — Pythia bypasses anti-debug, emulation reaches `LoadLibraryA`/`ShellExecuteW`, URL is decoded, analyst sees `github.com/AkashaCorporation`
- ⬜ Side-by-side capture (asciinema / screen recording) — the demo

### Phase 5 — Submission (Sunday Apr 26, 8pm EST cutoff)

- ⬜ One-page writeup (adapt `README.md`)
- ⬜ Demo video / recording
- ⬜ CV platform submission with repo URLs + branch links

## Budget

$500 in API credits dedicated. Routing: Haiku 4.5 default, Sonnet 4.6 on hard triggers (crypto / unpacking / multiple indirect calls / pause loops), Opus 4.7 reserved for a single "identify malware family" call per demo. Hard session cap $5 per end-to-end sample run. Expected total spend <$100 for the full week if Haiku hit rate stays high.

## For anyone continuing this work

1. Clone `Project-Pythia`, read `HANDOFF.md` in full.
2. Rehearsal mode runs without any API key — all four fixtures (`timing-check`, `peb-access`, `api-hash`, `exception`) validate offline.
3. Phase 1's live validation is the natural first thing to tackle with a real API key.
4. Do not rebuild the scaffolding. If something looks wrong, ask before changing.

## Dependencies / credits

- Issue author: @YasminePayload — original design, acceptance criteria, Decision JSON contract.
- Issue #31 (Zero-Copy IPC Shared Memory): **satisfied** by Project Perseus shipped in `hexcore-unicorn` 1.3.0 as part of HexCore v3.8.0 (Apr 20, 2026).
- HexCore main repo: https://github.com/AkashaCorporation/HikariSystem-HexCore (MIT + Apache 2.0, used as external dependency).
- Anthropic Claude (Haiku 4.5 / Sonnet 4.6 / Opus 4.7) via the official Agent SDK.

Will update this comment with progress daily. If the implementation lands cleanly, this issue can close after merge to HexCore `main` with the v3.9.0-preview release.
