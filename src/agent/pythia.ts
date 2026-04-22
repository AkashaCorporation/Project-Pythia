/**
 * Pythia agent — the decision loop.
 *
 * Two modes:
 *   - Rehearsal (no API key): deterministic stubs per trigger kind. Used for
 *     offline validation of the HexCore oracle plumbing without burning API.
 *   - Live (ANTHROPIC_API_KEY set): real Anthropic Messages API calls with
 *     tool_use loop. Claude sees the DecisionRequest as context, calls
 *     inspection tools (which round-trip to HexCore via the oracle client),
 *     then calls `decide` to emit the final DecisionResponse.
 *
 * The `decide` tool is terminal: when Claude calls it, the loop exits and
 * the tool input is translated into a DecisionResponse.
 *
 * Budget enforcement: every Messages API call is accounted. When 80% of
 * maxBudgetUsd is consumed, model is forced to Haiku. At 100%, the agent
 * degrades to rehearsal stubs with a warning.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type {
  DecisionRequest,
  DecisionResponse,
  ToolCall,
  ToolResult,
} from "../types/protocol.js";
import {
  chooseModel,
  MODEL_IDS,
  usageCostUsd,
  type ModelTier,
  type TokenUsage,
} from "./models.js";
import { PYTHIA_TOOLS } from "../tools/index.js";

export interface PythiaConfig {
  /** Path to the system prompt markdown. */
  systemPromptPath: string;
  /** Anthropic API key; if unset, pythia runs in rehearsal mode. */
  apiKey?: string;
  /** Hard budget cap in USD. When exceeded, agent degrades to rehearsal. */
  maxBudgetUsd: number;
  /** Default model tier (override per-request via route hints). */
  defaultModel?: ModelTier;
  /** Callback for tool calls — the oracle client wires this up. */
  onToolCall: (call: Omit<ToolCall, "kind" | "callId">) => Promise<ToolResult>;
  /** Optional logger. */
  logger?: (msg: string) => void;
}

export interface PythiaSessionStats {
  decisions: number;
  toolCalls: number;
  spentUsd: number;
  modelsUsed: Record<ModelTier, number>;
  degradedToRehearsal: boolean;
}

export class Pythia {
  private readonly config: PythiaConfig;
  private readonly log: (msg: string) => void;
  private readonly client?: Anthropic;
  private readonly systemPrompt: string;
  private stats: PythiaSessionStats = {
    decisions: 0,
    toolCalls: 0,
    spentUsd: 0,
    modelsUsed: { haiku: 0, sonnet: 0, opus: 0 },
    degradedToRehearsal: false,
  };

  constructor(config: PythiaConfig) {
    this.config = config;
    this.log = config.logger ?? (() => {});
    this.systemPrompt = readFileSync(config.systemPromptPath, "utf8");
    if (config.apiKey) {
      this.client = new Anthropic({ apiKey: config.apiKey });
    }
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    // Budget check.
    if (this.stats.spentUsd >= this.config.maxBudgetUsd) {
      if (!this.stats.degradedToRehearsal) {
        this.log(
          `[pythia] BUDGET EXCEEDED (${this.stats.spentUsd.toFixed(4)}/${this.config.maxBudgetUsd}) — degrading to rehearsal stubs`
        );
        this.stats.degradedToRehearsal = true;
      }
      return this.rehearsalStub(request, "haiku");
    }

    // Model routing (with budget-aware forcing).
    const budgetRatio = this.stats.spentUsd / this.config.maxBudgetUsd;
    const forceHaiku = budgetRatio >= 0.8;
    const model: ModelTier = forceHaiku
      ? "haiku"
      : chooseModel({
          triggerSuggestsHardProblem: this.isHardTrigger(request),
          pauseCount: request.session.pauseCount,
        });

    if (!this.client) {
      // Rehearsal mode.
      return this.rehearsalStub(request, model);
    }

    return this.liveDecide(request, model);
  }

  getStats(): Readonly<PythiaSessionStats> {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Live mode — Messages API + tool loop
  // ─────────────────────────────────────────────────────────────────────

  private async liveDecide(
    request: DecisionRequest,
    initialModel: ModelTier
  ): Promise<DecisionResponse> {
    const modelId = MODEL_IDS[initialModel];
    const userMessage = this.formatRequestAsUserMessage(request);

    // Assistant's running message history (includes tool results between turns).
    const conversation: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage },
    ];

    const MAX_ITERATIONS = 12;
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const response = await this.client!.messages.create({
        model: modelId,
        max_tokens: 2048,
        system: this.systemPrompt,
        tools: PYTHIA_TOOLS as unknown as Anthropic.Tool[],
        messages: conversation,
      });

      // Accounting.
      const usage: TokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: initialModel,
      };
      const cost = usageCostUsd(usage);
      this.stats.spentUsd += cost;
      this.stats.modelsUsed[initialModel]++;

      // Append assistant's response to conversation.
      conversation.push({ role: "assistant", content: response.content });

      // Scan for tool_use blocks.
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length === 0) {
        // No tool use — Claude emitted only text. If text is valid JSON, parse it.
        // Otherwise treat as a malformed decision and fall through to continue.
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        return this.parseTextFallback(request, text, initialModel, cost);
      }

      // Check for terminal tool: `decide`.
      const decideCall = toolUses.find((t) => t.name === "decide");
      if (decideCall) {
        this.stats.decisions++;
        return this.buildDecisionResponse(request, decideCall.input, initialModel, cost);
      }

      // Non-terminal tools — route through oracle, append tool_result.
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        try {
          const result = await this.dispatchTool(request.eventId, tu);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result.ok ? result.data : { error: result.error }),
            is_error: !result.ok,
          });
        } catch (e) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: (e as Error).message }),
            is_error: true,
          });
        }
      }
      conversation.push({ role: "user", content: toolResults });
    }

    // Iteration cap exceeded — emergency fallthrough.
    this.log(`[pythia] iteration cap hit for eventId ${request.eventId}; continuing`);
    this.stats.decisions++;
    return {
      kind: "decision_response",
      eventId: request.eventId,
      action: "continue",
      reasoning: "iteration cap exceeded",
      modelUsed: initialModel,
      costUsd: 0,
    };
  }

  private async dispatchTool(
    eventId: string,
    tu: Anthropic.ToolUseBlock
  ): Promise<ToolResult> {
    this.stats.toolCalls++;
    // Map Claude's tool_use to oracle ToolCall (narrowed by tool name).
    const tool = tu.name;
    const args = tu.input as Record<string, unknown>;

    // The oracle protocol's ToolCall discriminates on `tool`.
    // run_pipeline_job is handled locally (not via oracle) if a pipeline
    // dispatcher is wired; for now, we send it through the same channel.
    return await this.config.onToolCall({
      eventId,
      tool: tool as ToolCall["tool"],
      args: args as never,
    } as Omit<ToolCall, "kind" | "callId">);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  private formatRequestAsUserMessage(req: DecisionRequest): string {
    return [
      "A hook trigger fired during emulation. State follows. Inspect as needed, then call `decide`.",
      "",
      "```json",
      JSON.stringify(req, null, 2),
      "```",
    ].join("\n");
  }

  private buildDecisionResponse(
    req: DecisionRequest,
    input: unknown,
    model: ModelTier,
    cost: number
  ): DecisionResponse {
    const inp = input as {
      action: DecisionResponse["action"];
      patches?: DecisionResponse["patches"];
      skip?: DecisionResponse["skip"];
      reasoning?: string;
    };
    return {
      kind: "decision_response",
      eventId: req.eventId,
      action: inp.action,
      patches: inp.patches,
      skip: inp.skip,
      reasoning: inp.reasoning,
      modelUsed: model,
      costUsd: cost,
    };
  }

  private parseTextFallback(
    req: DecisionRequest,
    text: string,
    model: ModelTier,
    cost: number
  ): DecisionResponse {
    // Try to parse a JSON blob out of the text.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        this.stats.decisions++;
        return this.buildDecisionResponse(req, parsed, model, cost);
      } catch {
        // fallthrough
      }
    }
    this.log(`[pythia] text-only response, no parseable JSON; continuing`);
    this.stats.decisions++;
    return {
      kind: "decision_response",
      eventId: req.eventId,
      action: "continue",
      reasoning: "text-only response from model",
      modelUsed: model,
      costUsd: cost,
    };
  }

  private isHardTrigger(req: DecisionRequest): boolean {
    const reason = req.trigger.reason.toLowerCase();
    if (reason.includes("crypto") || reason.includes("unpack") || reason.includes("xor")) {
      return true;
    }
    if (req.trigger.kind === "exception") return true;
    const indirectCalls = req.context.disassembly.filter(
      (d) => d.mnemonic === "call" && d.operands.includes("[")
    ).length;
    return indirectCalls >= 2;
  }

  /**
   * Rehearsal mode — returns a deterministic Decision that matches trigger
   * intent. Used offline and as the final fallback when budget is exhausted.
   */
  private rehearsalStub(req: DecisionRequest, model: ModelTier): DecisionResponse {
    this.stats.decisions++;
    this.stats.modelsUsed[model]++;

    switch (req.trigger.kind) {
      case "timing_check":
        return {
          kind: "decision_response",
          eventId: req.eventId,
          action: "patch",
          patches: [{ target: "register", location: "rax", value: "0x10" }],
          reasoning: "rehearsal: timing delta zeroed",
          modelUsed: model,
          costUsd: 0,
        };
      case "peb_access":
        return {
          kind: "decision_response",
          eventId: req.eventId,
          action: "patch",
          patches: [{ target: "register", location: "rax", value: "0x0" }],
          reasoning: "rehearsal: PEB byte zeroed",
          modelUsed: model,
          costUsd: 0,
        };
      case "api":
        return {
          kind: "decision_response",
          eventId: req.eventId,
          action: "continue",
          reasoning: `rehearsal: observed api ${req.trigger.value}`,
          modelUsed: model,
          costUsd: 0,
        };
      case "exception":
        return {
          kind: "decision_response",
          eventId: req.eventId,
          action: "abort",
          reasoning: `rehearsal: exception ${req.trigger.value}`,
          modelUsed: model,
          costUsd: 0,
        };
      default:
        return {
          kind: "decision_response",
          eventId: req.eventId,
          action: "continue",
          reasoning: `rehearsal: no policy for ${req.trigger.kind}`,
          modelUsed: model,
          costUsd: 0,
        };
    }
  }
}
