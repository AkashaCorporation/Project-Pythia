# Pythia — Architecture

## Design goals

1. **Synchronous pause-and-respond.** Emulation blocks on a Decision. No fire-and-forget. HexCore must not proceed past a hook until Pythia says so.
2. **Sub-100ms transport overhead.** On Haiku, a decision round-trip (network + inference) is typically 400-900ms. Of that budget, the transport between HexCore and Pythia must be invisible — hence SharedArrayBuffer when both live on the same host.
3. **Zero state sharing in memory.** Pythia never reads HexCore's heap. All context is delivered as a serialized `DecisionRequest` payload. Pythia's tool calls request more context; HexCore serializes and returns it. This keeps the worker isolation model intact — a hung or crashed Pythia cannot corrupt HexCore.
4. **Graceful degradation.** If Pythia is unreachable / over-budget / stuck, HexCore falls through to `action: continue` (the identity decision) and emits a log line. Emulation never hangs waiting for an absent oracle.
5. **Budget-aware routing.** Every decision tracks cost. The agent runtime reports spend back to the session so long runs can be capped.

## The Oracle Hook, concretely

On the HexCore side (`feature/oracle-hook-hackathon`), the Oracle Hook consists of three components:

### 1. Trigger Registry

A table of `{ kind, value, callback }` entries registered by the Pythia client at session start. Examples:

```typescript
oracle.registerTrigger({ kind: "instruction", value: "0x140001a30" });
oracle.registerTrigger({ kind: "api", value: "QueryPerformanceCounter" });
oracle.registerTrigger({ kind: "peb_access" });  // fires on any gs:[0x60] dereference
oracle.registerTrigger({ kind: "timing_check" }); // fires after QPC/GetTickCount + sub + cmp
```

Trigger matching is hot-path. Instruction triggers are keyed in a `Set<bigint>` for O(1) lookup. API triggers are checked on IAT resolution boundaries, not per-instruction. The heuristic triggers (`peb_access`, `timing_check`) are compiled into the instruction stream by the existing hexcore-unicorn hook registration logic; see Project Perseus for the zero-copy path.

### 2. Pause Mechanism

When a trigger fires:
1. The emulation worker thread captures the register state, a disassembly window (±8 instructions around RIP), the call stack, and a memory window.
2. A `DecisionRequest` is serialized and written to the SharedArrayBuffer (or stdio pipe).
3. The worker atomically stores its state and blocks on a `futex` (or equivalent via `Atomics.wait` in JS-side pauses).
4. When Pythia writes a `DecisionResponse` back, the worker is signaled, validates the response, applies patches / skips, and resumes.

This matches what Project Perseus already does for hook callback delivery — same primitive, different payload.

### 3. Session Bridge

A TypeScript-side handle exposed via `hexcore.oracle.startSession`. Returns a `sessionId` and a connection descriptor (pipe name or SAB handle). The Pythia client attaches via that handle and speaks the protocol.

## Protocol

Defined in [`src/types/protocol.ts`](./src/types/protocol.ts) with Zod schemas for runtime validation on both sides.

Message envelope:

```typescript
type OracleMessage =
  | Handshake
  | DecisionRequest
  | DecisionResponse
  | ToolCall
  | ToolResult
  | SessionEnd;
```

All messages have a `kind` discriminator. Correlation via `eventId` (request/response pairs) and `callId` (tool call/result pairs).

### Message flow for a single pause

```
HexCore                              Pythia
───────                              ──────
                                     (idle, listening)

DecisionRequest  ───────────────────►
                                     (load request, invoke agent)
                                     Claude(system_prompt, request, tools)
                                     Claude decides to inspect memory first.

                 ◄───────────────── ToolCall(read_memory, 0x140002000, 64)
(resolve from
 emulator heap)
ToolResult       ──────────────────►
                                     Claude(...tool_result...)
                                     Claude decides.

                 ◄───────────────── DecisionResponse(patch rax=0x10)
(apply patch,
 resume emulation)
```

Multiple tool calls per pause are supported; the agent loops `tool_use` ↔ `tool_result` inside Anthropic's Messages API until it emits the final `DecisionResponse` as a text block.

## Tool set (Pythia's capabilities)

All tools are strictly read-only with respect to emulator state. The only mutating channel is the `DecisionResponse` itself. Tools exist to let the agent gather context before deciding.

| Tool | Purpose | Typical use |
|---|---|---|
| `read_memory(address, length)` | Peek emulator memory | Inspect a buffer passed to an API; read a string; dump a decryption key |
| `disassemble(address, count)` | Fetch disasm around a target | See what comes before/after the hook; inspect a callee |
| `get_registers()` | Refresh register snapshot | If patches from a prior pause need to be verified |
| `query_helix(functionAddress)` | Ask Helix for pseudo-C | Semantic understanding of the function containing the hook — essential for crypto / unpacking context |
| `search_hql(pattern)` | HQL pattern match over C-AST | *"Is this the PEB walk motif?"* / *"Where else does this hash appear?"* |
| `list_strings_near(address, radius)` | Strings within N bytes | Catch rolling-XOR URLs decoded nearby |
| `get_imports()` | List IAT entries | Confirm whether a resolved address actually maps to a known import |

## Model routing

Default: **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`).

Haiku handles ~90 % of decisions: timing patches, PEB byte flips, NtQueryInformationProcess class 7/30 bypass, single-API hash resolution, register zero-outs. These are mechanical patterns.

Escalate to **Claude Sonnet 4.6** when:
- The trigger `reason` hints at crypto / unpacking / XOR (keyword match).
- The disassembly contains multiple indirect calls (likely a dispatcher).
- Haiku has paused on this specific address more than twice without converging.

Escalate to **Claude Opus 4.7** when:
- We've already been on Sonnet for 5+ pauses at the same site.
- The session has triggered a family-identification request.
- Less than once per session, by design.

All three share the same system prompt. Tool definitions are identical. The only difference is model capability and cost, which is why the routing is transparent to Pythia herself — she just receives the request and responds.

## Budget control

Per-session budget: configurable, default **$5 USD**. Every decision emits a token-usage record with `{ model, inputTokens, outputTokens }` which is converted to USD via the pricing table in [`src/agent/models.ts`](./src/agent/models.ts).

When 80 % of budget is consumed, the runtime forces model tier down to Haiku regardless of routing hints. At 100 %, the session degrades to mechanical auto-decisions (same deterministic stubs used in rehearsal mode) and emits a warning log.

## Failure modes and fallbacks

| Failure | Fallback |
|---|---|
| Pythia unreachable (transport error) | HexCore emits `DecisionResponse{action: "continue"}` after 2s timeout. |
| Pythia returns invalid JSON | Same — fallthrough to continue, log the malformed response. |
| Budget exceeded | Force Haiku; if still over at hard cap, use rehearsal stub. |
| Agent exception during decide() | Catch, log, return `action: "continue"`. |
| HexCore emulator exception | Trigger kind `exception` is raised; Pythia's default policy is `action: "abort"`. |

The invariant: **HexCore never hangs waiting for Pythia**. Every code path has a timeout-based fallback.

## Rehearsal vs. live

`Pythia.decide()` checks for `config.apiKey`:

- **Unset (default)** — Rehearsal mode. `rehearsalStub()` returns deterministic decisions based on trigger kind. Used for offline development of the HexCore plumbing before the agent goes live.
- **Set** — Live mode. Anthropic Messages API is called with the system prompt, request payload, and tool set.

The same interface. The same response shape. The HexCore side cannot tell the difference — which is exactly the point: the transport + protocol can be validated without burning a single API credit.
