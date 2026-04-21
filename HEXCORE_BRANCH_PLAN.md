# HexCore `feature/oracle-hook-hackathon` — implementation plan

This document lives in the Pythia repo for convenience but describes work that lands on the HexCore monorepo (`vscode-main`).

## Branch

- **Name:** `feature/oracle-hook-hackathon`
- **Base:** `main` at commit tagged `v3.8.0` (the stable release).
- **Target:** merge to `main` post-hackathon as part of **v3.9.0-preview**.

All commits on this branch must be dated within the hackathon window (Apr 21-26, 2026) to satisfy the submission provenance requirement.

## Guiding principles

1. **Net new code only.** No refactors of existing HexCore subsystems. The hook adds surface; it does not reshape what's there.
2. **Behind a flag by default.** `hexcore.oracle.enabled` setting, default `false`. Emulation without the flag must be bit-identical to v3.8.0.
3. **Reuse Project Perseus.** The SharedArrayBuffer zero-copy channel landed in v3.8.0 for hook callback delivery. Oracle messages piggyback on that same primitive. Do not invent a second transport.
4. **Keep the worker isolation model.** A crashed Pythia must not affect the emulator heap. Panic in the oracle path → emit `action: continue` fallback, log, proceed.

## Engine target — hexcore-unicorn only (for the hackathon)

HexCore has two emulation fronts: `hexcore-unicorn` (classic N-API binding) and `hexcore-elixir` (Project Azoth — NAPI-RS + C++23 engine that links directly against `unicorn.dll`). These are **peer consumers** of Unicorn, not a stack — Elixir does not call through hexcore-unicorn's N-API.

**For the hackathon, the Oracle Hook lives in hexcore-unicorn only.** Rationale:
- Project Perseus (the SAB IPC channel we piggyback on) is in hexcore-unicorn. Oracle Hook is the next layer on Perseus — keep them co-located.
- The demo path uses `hexcore.debug.emulateFullHeadless`, which flows JS → N-API → hexcore-unicorn → Unicorn. The hook is in the N-API binding layer; no need to touch Elixir.
- Wiring Oracle through Elixir's Rust + C++23 layers (Interceptor surface) is the natural post-hackathon integration path. It becomes a feature of `hexcore.elixir.*` commands in v3.9.0 stable. Out of scope for the hackathon week.

If during the week the demo scope shifts to specifically show Pythia driving Project Azoth (e.g. because the judges value the Elixir integration), that becomes a second branch `feature/oracle-elixir-integration` with its own plan. Do not conflate with this branch.

## File layout (new files)

```
extensions/hexcore-unicorn/
  src/
    oracle-hook.ts                 ← trigger registry + pause/resume
    oracle-protocol.ts             ← mirror of protocol.ts (types only)
    oracle-transport.ts            ← SAB + stdio NDJSON encoders
  src/
    unicorn_wrapper.cpp            ← MODIFY: trigger check in hook loop (~30 LOC)

extensions/hexcore-disassembler/
  src/
    oracleSession.ts               ← public API: startSession, registerTrigger,
                                     attachClient, close. Thin wrapper over
                                     hexcore-unicorn oracle-hook.
    oracleCommands.ts              ← three new VS Code commands (below)
  package.json                     ← MODIFY: declare commands + settings

docs/
  ORACLE_HOOK.md                   ← user-facing doc: how to attach an agent,
                                     what triggers are supported, protocol ref
```

## Protocol types

Copy `Project-Pythia/src/types/protocol.ts` verbatim into `hexcore-unicorn/src/oracle-protocol.ts`. Zod is already a transitive dep via better-sqlite3 tooling; if not, add it to `hexcore-unicorn` devDependencies.

Keep the two copies in sync manually for the hackathon. Post-hackathon, extract to `hexcore-common`.

## New VS Code commands

Declared in `extensions/hexcore-disassembler/package.json`:

- `hexcore.oracle.startSession` — Opens an oracle-enabled emulation session for the current binary. Returns `sessionId + connectionDescriptor`. UI: quickpick prompting for sample path + initial trigger set.
- `hexcore.oracle.attachAgent` — Attach an external Pythia process to an existing session. Args: `{ sessionId, transport: "sab" | "stdio" }`.
- `hexcore.oracle.listSessions` — Enumerate active oracle sessions in the current workspace.

Settings:

- `hexcore.oracle.enabled` (boolean, default `false`)
- `hexcore.oracle.defaultTransport` (`"sab" | "stdio"`, default `"sab"`)
- `hexcore.oracle.pauseTimeoutMs` (integer, default `2000`) — how long HexCore waits for a DecisionResponse before falling through to continue.

## C++ changes (unicorn_wrapper.cpp)

Minimal. In the existing hook callback, after delivering the standard event to the JS side via SharedArrayBuffer:

```cpp
if (oracle_enabled && oracle_matches_trigger(pc, api_name)) {
    oracle_pause_and_wait(&ctx);  // blocks until decision arrives
    oracle_apply_decision(&ctx);  // patch regs/memory, adjust pc for skip
}
```

`oracle_pause_and_wait` uses the same `Atomics.wait` / futex pattern Project Perseus uses for hook acknowledgment — zero new C++ primitives.

## Trigger types to support on day 1

| Kind | Day 1? |
|---|---|
| `instruction` | ✅ Required — simplest, foundational |
| `api` | ✅ Required |
| `exception` | ✅ Required — fallthrough for emulator faults |
| `timing_check` | ⬜ Nice to have — heuristic, can ship on day 2 |
| `peb_access` | ⬜ Nice to have |
| `memory_read` / `memory_write` | ⬜ Day 2+ |

Day 1 goal: Pythia can register a trigger on `0x140001a30`, hit it, see the pause, send `continue`, observe resume. That's the entire stack working end-to-end against a trivial sample.

## Testing hooks

- **Offline fixture generator:** a small helper in `extensions/hexcore-unicorn/src/oracleFixtures.ts` that captures a `DecisionRequest` payload at a known address in a test binary and dumps it to `test/fixtures/<scenario>.json`. Those fixtures feed the Pythia rehearsal mode.
- **Integration test:** `hexcore-unicorn/test/oracle.spec.ts` that spawns a dummy Pythia-shaped responder (hardcoded JSON) over stdio and runs an emulation of a small test binary, verifying that `continue`, `patch`, and `skip` all produce the expected final register state.

## Not doing in this branch

Explicitly out of scope for the hackathon:

- HQL integration of oracle decision traces (cool, but v3.9.0)
- Persistent decision log (beyond in-session stats)
- Multi-agent sessions (one Pythia per session; adding pools is post-hackathon)
- Windows service integration for remote oracle connections

## Merge plan

1. PR `feature/oracle-hook-hackathon` → `main` opens Monday Apr 27 post-submission.
2. Requires: green CI on `hexcore-native-prebuilds.yml`, one approving review, no regressions against the v3.8.0 test corpus.
3. Target: ship as `v3.9.0-preview.1` within 2 weeks of merge. Full `v3.9.0` when sessionId sticky routing (#26) + BinDiff also land.
