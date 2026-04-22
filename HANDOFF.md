# HANDOFF — Switching to the hackathon account

This file is a short, opinionated playbook for picking up Pythia development on the hackathon account (where the Claude API key and $500 in credits live) after the scaffolding was done on a different account.

**You are Claude reading this.** The context you need is all in this repo. The human you're working with is LXrdKnowkill, hackathon participant. The project is **Project Pythia**, implementing [HexCore Issue #17](https://github.com/AkashaCorporation/HikariSystem-HexCore/issues/17). Submission deadline: **Sunday Apr 26 2026, 8pm EST**.

## First 10 minutes

1. **Read these files in order**, then stop and tell the human you're ready:
   - `README.md` — what this is
   - `ARCHITECTURE.md` — protocol, routing, fallbacks
   - `HEXCORE_BRANCH_PLAN.md` — what goes on the HexCore side
   - `prompts/system.md` — Pythia's persona + tool usage rules
   - `src/types/protocol.ts` — the wire format
2. **Do NOT re-architect.** The scaffolding is deliberate. If something looks wrong, ask before changing.
3. **Do NOT bump dep versions.** `package.json` is pinned to Anthropic SDK + Agent SDK + zod versions chosen for compatibility.

## Environment setup

```bash
cd <path-to-this-repo-clone>
npm install
```

Set the API key (Windows cmd):
```cmd
set ANTHROPIC_API_KEY=sk-ant-...
```

Or PowerShell:
```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Or persist in a local `.env` (already in `.gitignore`):
```
ANTHROPIC_API_KEY=sk-ant-...
```

Sanity check:
```bash
npm run typecheck
npm run build
```

Both must pass clean.

## Verify rehearsal still works (no API burn)

```bash
npx tsx src/cli.ts rehearse --scenario timing-check
npx tsx src/cli.ts rehearse --scenario peb-access
npx tsx src/cli.ts rehearse --scenario api-hash
npx tsx src/cli.ts rehearse --scenario exception
```

Each should emit a `DecisionResponse` JSON on stdout and a one-line `[pythia] stats: ...` on stderr. Zero API calls. If any crash, the scaffolding broke — do not proceed, diagnose.

## What's NOT yet wired (your job for the hackathon)

### Phase 1 — Live decide() validation (day 1, ~1 hour)

`src/agent/pythia.ts` already has `liveDecide()` implemented with the Messages API tool loop. But it's never been run. Task:

1. Write a **tiny** standalone test in `test/live-smoke.ts` that constructs a `Pythia` with `apiKey` set, invokes `decide()` with the `timing-check.json` fixture, and prints the response.
2. Run it with Haiku (default). Verify the response is a valid `DecisionResponse`.
3. **Expected:** Claude calls `decide` with `action: "patch"` and a register patch zeroing the timing delta. Total cost should be ~$0.003 (Haiku is cheap).
4. If it crashes, the most likely cause is the tool type casts in `PYTHIA_TOOLS` vs `Anthropic.Tool`. The Anthropic SDK's `Tool` type expects slightly different shape than our `tool_use_*` definitions. Fix at the cast, not at the declarations.

### Phase 2 — Oracle transport (day 1-2, ~2 hours)

`src/oracle/client.ts` is written for stdio NDJSON. But no HexCore process is producing frames yet. Two sub-tasks:

1. **Mock HexCore harness** at `test/mock-hexcore.ts` — a Node script that pipes a fixture into Pythia's stdin and reads responses from stdout. Use this to validate the full transport round-trip offline.
2. **Wire `onToolCall` through the client.** In the mock harness, implement fake tool responses (e.g. `read_memory` returns deterministic bytes). Validate that Claude sees the tool results and decides correctly.

### Phase 3 — HexCore branch (day 2-3, ~1 day)

Switch to the HexCore monorepo:
```
<path-to-your-HexCore-clone>
```

Branch from `main` at `v3.8.0`:
```bash
git checkout -b feature/oracle-hook-hackathon v3.8.0
```

Follow `HEXCORE_BRANCH_PLAN.md` in this repo. New files go in `extensions/hexcore-unicorn/src/` and `extensions/hexcore-disassembler/src/`. Keep C++ diff to `unicorn_wrapper.cpp` under 50 lines.

**Build reminder:** the user's local HexCore build uses `--no-verify` on commits (documented in their memory — Microsoft hygiene hook mismatch with HikariSystem headers). Use `git commit --no-verify`.

### Phase 4 — End-to-end demo (day 3-4)

Target sample: the `Malware HexCore Defeat.exe` v6.1 "Echo Mirage" build — a dummy engineered specifically to evade HexCore v3.8.0. Kept in a private corpus repo; analysts supply their own path when invoking the runner.

The demo must show:
1. Baseline run of v6.1 against `hexcore.debug.emulateFullHeadless` — emulation trips anti-debug, sample exits, no beacon observed.
2. Same binary, same command, but with `--oracle pythia` flag — Pythia bypasses the anti-debug live, emulation reaches the beacon code, URL is decoded, analyst sees `https://github.com/AkashaCorporation`.

If both are captured (asciinema or video), that's the demo. Simple, clean, unambiguous.

### Phase 5 — Submission (Sunday Apr 26 by 8pm EST)

Via the CV platform. Artifacts to include:
- Repo URL: `github.com/AkashaCorporation/Project-Pythia`
- HexCore branch: `github.com/AkashaCorporation/HikariSystem-HexCore/tree/feature/oracle-hook-hackathon`
- Demo recording
- One-page writeup (adapt `README.md` intro)

## Budget plan ($500 total)

Hard session cap: **$5 per end-to-end sample run.** Soft cap: **Haiku for 90% of decisions, Sonnet for 10%, Opus only for a single final "identify family" call per demo.**

Estimated spend:
- Dev iterations on prompt engineering (running rehearsal + one or two live flows): **~$20**
- Phase 4 demo runs + edge cases: **~$50**
- Recording / polish / retries: **~$30**
- Buffer: **~$400**

If you hit $100 spent and the demo still doesn't work, stop and diagnose before spending more.

## Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: Invalid JSON in tool_use input` | Claude hallucinated args for a tool | Tighten `input_schema`'s `required` fields or add clearer description |
| Rehearsal fixtures pass but live mode times out | Tool result round-trip blocked — mock harness not wired | See Phase 2 |
| Pythia keeps calling `read_memory` forever | Tool iteration cap `MAX_ITERATIONS` in `pythia.ts` (default 12) — tighten system prompt to prefer faster decisions |
| Cost overruns | Inspect `getStats().modelsUsed` — if Sonnet/Opus used too often, adjust `chooseModel()` thresholds |
| HexCore build fails after branch changes | Check if new command registrations have matching entries in `package.json` `contributes.commands` — the pipeline capability map requires both |

## Do not

- Do not push the HexCore branch to `main` during the hackathon. PR lives open; merge post-submission.
- Do not publish `Project-Pythia` to npm during the hackathon. Public repo is fine; published package is not needed.
- Do not commit the API key. `.env` is in `.gitignore` — keep it there.
- Do not refactor the Pythia class during a live run iteration. If something is wrong, revert to last known working state and try a smaller change.

## Contact signals with the human

The human is active most of Apr 21-26. If blocked:
- Describe what you tried, in one paragraph
- Name the specific file + function you're stuck on
- Ask ONE question, not five

They prefer Portuguese in casual conversation, English in code comments. Match the language of their last message.
