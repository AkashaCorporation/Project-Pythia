<div align="center">

<img src="./banner.png" alt="Pythia — Oracle Agent for HexCore" width="640"/>

# Pythia — Oracle Agent for HexCore

**Observe. Decide. Protect.** — *the Oracle Hook is the law.*

</div>

> *Autonomous reverse-engineering agent. Drives HexCore's emulation engine mid-execution, making live decisions that bypass anti-analysis, resolve hashed APIs, and extract real behavior from hostile samples.*

**Project Pythia** is an Anthropic hackathon project (Apr 21-26, 2026). It combines two things that have never been glued together before:

1. **Issue [#17 Oracle Hook](https://github.com/AkashaCorporation/HikariSystem-HexCore/issues/17)** — a pause-and-respond callback system originally proposed by [@YasminePayload](https://github.com/YasminePayload) to let external agents intervene during headless emulation.
2. **Claude Agent SDK** — Anthropic's framework for building tool-wielding autonomous agents.

Pythia is the bridge. She registers as an Oracle listener on a HexCore emulation session, receives Decision Requests at every hook trigger, inspects the machine state with her tool set, and issues Decisions that HexCore applies before resuming execution.

---

## Built on

Pythia is built on top of **[HexCore](https://github.com/AkashaCorporation/HikariSystem-HexCore)**, an MIT + Apache 2.0 licensed binary analysis IDE maintained by @LXrdKnowkill. HexCore provides the execution infrastructure — decompilation pipeline, pattern matching engine (HQL), CPU emulation (Unicorn), static analysis (Capstone / LLVM-MC), session persistence — that Pythia orchestrates.

### What was built during the hackathon

- **`Project-Pythia`** (this repo) — 100 % new code, started April 21, 2026.
- **Oracle Hook** — new contribution to HexCore on branch [`feature/oracle-hook-hackathon`](https://github.com/AkashaCorporation/HikariSystem-HexCore/tree/feature/oracle-hook-hackathon). All commits dated within the hackathon window.

### What existed before

HexCore's core infrastructure (decompiler, HQL engine, automation pipeline, Unicorn emulation integration, **SharedArrayBuffer zero-copy IPC channel — shipped as Project Perseus in HexCore v3.8.0**) existed before the hackathon and is used as an open-source dependency. The same way any project uses Node.js, LLVM, or Capstone.

---

## Why this matters

Every modern dynamic analysis sandbox has the same failure mode: hostile samples use timing checks, PEB reads, environment fingerprinting, and API hash resolution to detect the sandbox and abort silently. The analyst sees *"no malicious behavior observed"* — and the sample walks.

The classical defenses are:

- **Hardcoded bypasses** — one patch per known anti-debug variant. Doesn't scale.
- **Manual reverse engineering** — works, but costs an analyst hours per sample.
- **Post-mortem re-emulation with patched input** — slow, doesn't handle non-determinism.

Pythia is a fourth path: **let a language model make the decisions**, in real time, during emulation. Claude understands the context (registers, disassembly, pseudo-C, call stack) that a static patch list never could. When a new anti-debug variant appears, Pythia decides what to do on the fly, no engine update required.

---

## Architecture (high level)

```
┌──────────────────────────────────────────────────────────────┐
│                    Pythia Agent                              │
│                                                              │
│   ┌──────────────┐    system prompt + request + tools        │
│   │   Claude     │ ──────────────────────────────────┐       │
│   │  (Haiku /    │                                   │       │
│   │  Sonnet /    │ ◄── DecisionResponse / ToolCall ──┘       │
│   │   Opus)      │                                           │
│   └──────────────┘                                           │
│          ▲                                                   │
│          │  DecisionRequest       ┌─────────────────┐        │
│          │ ─────────────────────► │  Oracle Client  │        │
│          │ ◄──────────────────── │  (this repo)     │        │
│          │  DecisionResponse     └─────────────────┘         │
│                                          ▲                   │
└──────────────────────────────────────────┼───────────────────┘
                                           │
                                SharedArrayBuffer /
                                 stdio NDJSON
                                           │
┌──────────────────────────────────────────┼───────────────────┐
│                    HexCore                ▼                  │
│                                                              │
│  ┌────────────────────┐   pause    ┌──────────────────────┐  │
│  │  hexcore-unicorn   │ ─────────► │   Oracle Hook        │  │
│  │   (emulator)       │            │  (new on hackathon   │  │
│  │                    │ ◄───────── │   branch)            │  │
│  └────────────────────┘   resume   └──────────────────────┘  │
│                                                              │
│  + helix (decompiler), HQL (pattern matching),               │
│    pathfinder (type recovery), elixir (Project Azoth)        │
└──────────────────────────────────────────────────────────────┘
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full protocol spec, tool set reference, and model routing rationale.

---

## Status

This repository is **scaffolded, not yet wired live**. The goals for the hackathon week:

| Day | Target |
|---|---|
| Tue Apr 21 | Protocol spec, agent scaffold, HexCore branch plan (this commit) |
| Wed Apr 22 | HexCore `feature/oracle-hook-hackathon` — trigger registry + pause/resume plumbing |
| Thu Apr 23 | SharedArrayBuffer transport + stdio NDJSON transport, end-to-end handshake |
| Fri Apr 24 | Claude Agent SDK integration, live decide() loop, first real bypass demo |
| Sat Apr 25 | Tool set fleshed out (read_memory, disassemble, query_helix, search_hql) |
| Sun Apr 26 | Full demo run: Pythia vs. `Malware HexCore Defeat v6.1` + fresh MalwareBazaar sample. Submission. |

---

## Quickstart (rehearsal mode — no API key)

```bash
npm install
npm run build
npx pythia rehearse --scenario timing-check
```

Rehearsal runs a deterministic stub decision against a fixture. Used to validate the HexCore oracle plumbing before the live agent is wired. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how to switch into live mode once the API key is set.

---

## License

MIT. See [`LICENSE`](./LICENSE).

HexCore itself is dual-licensed MIT + Apache 2.0 and is consumed here as an external dependency.

## Credits

- **@YasminePayload** — original Oracle Hook proposal ([HexCore #17](https://github.com/AkashaCorporation/HikariSystem-HexCore/issues/17))
- **@LXrdKnowkill** — HexCore, architecture, Pythia implementation
- **Anthropic Claude hackathon** — for the deadline that made this happen
