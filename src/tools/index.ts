/**
 * Tool registry — lists all tools available to Pythia.
 *
 * Tools are declared with:
 *   - Anthropic-shaped `toolDef` (name + description + input_schema) for
 *     the Messages API `tools` parameter.
 *   - `argsSchema` (Zod) for runtime validation of args that Claude produces.
 *   - `resultSchema` (Zod) for validation of the HexCore-side response.
 *
 * Each tool maps to a specific `ToolCall.tool` discriminant in the oracle
 * protocol. The agent runner translates Claude's tool_use blocks into
 * ToolCall messages and routes them through the oracle client; the HexCore
 * side handles the actual work (reading memory, disassembling, etc.).
 *
 * HACKATHON NOTE: the actual fetch side (oracle client → HexCore → response)
 * is implemented in `../oracle/client.ts`. This file only declares the tool
 * surface that Pythia sees.
 */

import { runPipelineJobToolDef, RunPipelineJobArgsSchema, RunPipelineJobResultSchema } from "./run-pipeline-job.js";

// ─── Inspection tools (per-pause, lightweight) ────────────────────────────

export const readMemoryToolDef = {
  name: "read_memory",
  description:
    "Read bytes from the emulator's memory at a given address. Returns hex bytes. Use this to inspect buffers passed to APIs, strings at known offsets, decryption keys in memory, or to verify a patch you intend to apply.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Start address as 0x-prefixed hex." },
      length: { type: "integer", minimum: 1, maximum: 4096, description: "Number of bytes to read (max 4096)." },
    },
    required: ["address", "length"],
  },
} as const;

export const disassembleToolDef = {
  name: "disassemble",
  description:
    "Disassemble N instructions starting at a given address. Returns {address, bytes, mnemonic, operands}[]. Use to inspect a callee, look at code surrounding RIP, or trace into a computed jump target.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Start address as 0x-prefixed hex." },
      count: { type: "integer", minimum: 1, maximum: 64, description: "Number of instructions (max 64)." },
    },
    required: ["address", "count"],
  },
} as const;

export const queryHelixToolDef = {
  name: "query_helix",
  description:
    "Ask Helix to decompile a function to pseudo-C. Input is any address inside the function; Helix discovers the function boundaries and produces pseudo-C with type recovery. Use this when per-instruction disassembly isn't enough to understand WHY a function is doing something.",
  input_schema: {
    type: "object",
    properties: {
      functionAddress: { type: "string", description: "Address anywhere inside the target function." },
    },
    required: ["functionAddress"],
  },
} as const;

export const searchHqlToolDef = {
  name: "search_hql",
  description:
    "Run a HexCore Query Language (HQL) semantic pattern match against the binary's C-AST. Useful for finding motifs across the program ('where else does this hash appear?', 'any other PEB walks?'). HQL patterns target C-AST node shapes, not text regex.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "HQL pattern string." },
    },
    required: ["pattern"],
  },
} as const;

export const listStringsNearToolDef = {
  name: "list_strings_near",
  description:
    "List strings in the binary within `radius` bytes of a given address. Useful when you suspect a rolling-XOR decoder decodes into memory close to its source.",
  input_schema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Focus address as 0x-prefixed hex." },
      radius: { type: "integer", minimum: 16, maximum: 4096, description: "Search radius in bytes." },
    },
    required: ["address"],
  },
} as const;

export const getImportsToolDef = {
  name: "get_imports",
  description:
    "List the binary's import table (IAT). Returns module → [api] mapping. Useful to confirm whether a resolved hash maps to a real imported API, or to spot minimal IATs that indicate manual hash resolution.",
  input_schema: {
    type: "object",
    properties: {},
  },
} as const;

// ─── Terminal tool (the Decision) ─────────────────────────────────────────

export const decideToolDef = {
  name: "decide",
  description:
    "Emit the final Decision for this pause. This terminates the tool-use loop; after calling `decide`, the emulator applies the decision and resumes. Call this EXACTLY ONCE per DecisionRequest.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["continue", "patch", "skip", "patch_and_skip", "abort"],
        description: "Action to take.",
      },
      patches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["register", "memory", "flag"] },
            location: { type: "string", description: "Register name (rax..r15), address hex, or flag name." },
            value: { type: "string", description: "Hex or decimal value to write." },
            size: { type: "integer", description: "Bytes for memory patches." },
          },
          required: ["target", "location", "value"],
        },
      },
      skip: {
        type: "object",
        properties: {
          instructions: { type: "integer" },
          untilAddress: { type: "string" },
        },
      },
      reasoning: {
        type: "string",
        description: "ONE short line for trace logging. No paragraphs.",
      },
    },
    required: ["action"],
  },
} as const;

// ─── Registry export ──────────────────────────────────────────────────────

/**
 * The full tool set Pythia is given in every decide() call.
 * Order matters only for presentation; Claude can call any subset.
 */
export const PYTHIA_TOOLS = [
  // Inspection — cheap, use liberally
  readMemoryToolDef,
  disassembleToolDef,
  queryHelixToolDef,
  searchHqlToolDef,
  listStringsNearToolDef,
  getImportsToolDef,
  // Heavy — last resort
  runPipelineJobToolDef,
  // Terminal — exactly one per pause
  decideToolDef,
] as const;

export {
  RunPipelineJobArgsSchema,
  RunPipelineJobResultSchema,
};
