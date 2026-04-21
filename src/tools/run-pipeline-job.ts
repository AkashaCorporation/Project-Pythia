/**
 * Tool: run_pipeline_job
 *
 * Lets Pythia dispatch a `.hexcore_job.json` pipeline to gather static context
 * when the live emulation state alone is insufficient to make a decision.
 *
 * Common use cases:
 *   - "I don't recognize this function; run quick-triage + analyzeAll and let
 *      me see the disassembly + YARA hits."
 *   - "The sample looks packed; run full-static and check entropy + sections."
 *   - "I need Helix pseudo-C for the caller; dispatch a targeted helix.decompile."
 *
 * The tool returns the pipeline's structured output. Pythia pauses her decision
 * until the pipeline completes (or times out). Budget-aware: large pipelines
 * count against the session's total time budget.
 *
 * IMPORTANT: this is a *heavy* tool. Use it when query_helix / disassemble /
 * read_memory aren't enough. Default to the lighter tools first.
 */

import { z } from "zod";

export const RunPipelineJobArgsSchema = z.object({
  /**
   * Either a preset name from HexCore's built-in templates, or an inline
   * pipeline definition. Inline takes precedence if both are provided.
   */
  preset: z
    .enum([
      "quick-triage",        // filetype + hash + entropy + strings (~30s)
      "full-static",         // + disasm + YARA + IOC + report (~5min)
      "ctf-reverse",         // tuned for CTF-style crackmes
      "adaptive-malware",    // onResult branching on entropy
    ])
    .optional(),

  /**
   * Inline steps — list of headless commands to run. Pythia should keep this
   * tight (3-6 steps max) to control cost.
   */
  steps: z
    .array(
      z.object({
        cmd: z.string(),
        args: z.record(z.unknown()).optional(),
        timeoutMs: z.number().int().positive().optional(),
        continueOnError: z.boolean().optional(),
        output: z.object({ path: z.string() }).optional(),
      })
    )
    .optional(),

  /** Absolute path to the binary. If unset, uses the current oracle session's binary. */
  file: z.string().optional(),

  /** How long to wait for pipeline completion. Hard cap: 10 minutes. */
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),

  /**
   * Which step outputs Pythia wants returned. If unset, returns all step
   * results. Narrowing this reduces token usage on the Pythia side.
   */
  returnSteps: z.array(z.number().int().nonnegative()).optional(),
});
export type RunPipelineJobArgs = z.infer<typeof RunPipelineJobArgsSchema>;

export const RunPipelineJobResultSchema = z.object({
  ok: z.boolean(),
  jobId: z.string().optional(),
  durationMs: z.number().nonnegative(),
  steps: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      cmd: z.string(),
      status: z.enum(["success", "error", "skipped", "timeout"]),
      result: z.unknown().optional(),
      error: z.string().optional(),
    })
  ),
  finalReport: z.string().optional(),   // path to composed report if included
  error: z.string().optional(),
});
export type RunPipelineJobResult = z.infer<typeof RunPipelineJobResultSchema>;

/**
 * Tool definition for Anthropic Messages API `tools` parameter.
 * Injected into Pythia's tool set by the agent runner.
 */
export const runPipelineJobToolDef = {
  name: "run_pipeline_job",
  description:
    "Dispatch a HexCore pipeline job to gather static context when live emulation state is insufficient for a decision. Returns structured output from each step. Use sparingly — this is heavy. Prefer lighter tools (read_memory, disassemble, query_helix) first.\n\n" +
    "Presets available:\n" +
    "  - quick-triage: filetype + hash + entropy + strings (~30s)\n" +
    "  - full-static: + analyzeAll + YARA + IOC + report (~5min)\n" +
    "  - ctf-reverse: tuned for crackme-style samples\n" +
    "  - adaptive-malware: onResult branching on entropy\n\n" +
    "Or provide inline `steps` (3-6 max) for a targeted run.",
  input_schema: {
    type: "object",
    properties: {
      preset: {
        type: "string",
        enum: ["quick-triage", "full-static", "ctf-reverse", "adaptive-malware"],
        description: "HexCore built-in pipeline preset to dispatch.",
      },
      steps: {
        type: "array",
        description: "Inline pipeline steps (alternative to preset).",
        items: {
          type: "object",
          properties: {
            cmd: { type: "string", description: "Headless command name, e.g. hexcore.disasm.analyzeAll" },
            args: { type: "object" },
            timeoutMs: { type: "integer" },
            continueOnError: { type: "boolean" },
            output: { type: "object", properties: { path: { type: "string" } } },
          },
          required: ["cmd"],
        },
      },
      file: { type: "string", description: "Absolute binary path. Defaults to current oracle session binary." },
      timeoutMs: { type: "integer", description: "Pipeline completion wait (max 600000)." },
      returnSteps: {
        type: "array",
        items: { type: "integer" },
        description: "Indices of step outputs to return (default: all).",
      },
    },
  },
} as const;
