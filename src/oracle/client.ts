/**
 * Oracle Client — transport layer between Pythia and HexCore.
 *
 * Two transports are supported:
 *   - `stdio` — NDJSON frames over stdin/stdout. Simplest; works with any
 *     subprocess. Used for local dev and CI. Latency ~1ms per frame.
 *   - `sab`   — SharedArrayBuffer ring buffer via the Project Perseus
 *     channel. Used when Pythia and HexCore share a process tree. Latency
 *     ~10us per frame. Not yet wired — falls back to stdio.
 *
 * The client exposes:
 *   - `connect()` — open the transport and do handshake.
 *   - `onDecisionRequest(cb)` — register handler for pause events.
 *   - `sendToolCall(call)` — fire a tool call; awaits ToolResult.
 *   - `sendDecisionResponse(resp)` — terminal reply for a pause.
 *   - `close()` — clean shutdown.
 *
 * Message correlation:
 *   - DecisionRequest.eventId is echoed in DecisionResponse.eventId.
 *   - ToolCall.callId is echoed in ToolResult.callId.
 *   - Out-of-order responses are supported via pending-promise maps.
 */

import { createInterface, type Interface } from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  DecisionRequest,
  DecisionResponse,
  ToolCall,
  ToolResult,
  OracleMessage,
  Handshake,
  SessionEnd,
} from "../types/protocol.js";
import { OracleMessageSchema } from "../types/protocol.js";

export type Transport = "stdio" | "sab";

export interface OracleClientConfig {
  transport: Transport;
  pythiaVersion: string;
  capabilities: string[];
  logger?: (msg: string) => void;
}

export type DecisionRequestHandler = (req: DecisionRequest) => Promise<DecisionResponse>;

const HANDSHAKE_TIMEOUT_MS = 5_000;
const TOOL_CALL_TIMEOUT_MS = 30_000;

export class OracleClient {
  private readonly config: OracleClientConfig;
  private readonly log: (msg: string) => void;
  private rl?: Interface;
  private connected = false;
  private handshakeReceived = false;
  private hexcoreVersion = "unknown";
  private decisionHandler?: DecisionRequestHandler;

  /** callId -> { resolve, reject, timer } for pending tool calls. */
  private readonly pendingToolCalls = new Map<
    string,
    { resolve: (r: ToolResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(config: OracleClientConfig) {
    this.config = config;
    this.log = config.logger ?? (() => {});
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async connect(): Promise<Handshake> {
    if (this.config.transport === "sab") {
      this.log("[oracle] sab transport requested; falling back to stdio for hackathon scope");
    }
    this.rl = createInterface({ input: process.stdin });
    this.rl.on("line", (line) => this.onLine(line));
    this.connected = true;

    const handshake: Handshake = {
      kind: "handshake",
      protocolVersion: 1,
      hexcoreVersion: "pending",
      pythiaVersion: this.config.pythiaVersion,
      capabilities: this.config.capabilities,
    };
    this.send(handshake);

    return await this.awaitHandshake();
  }

  close(): void {
    for (const { reject, timer } of this.pendingToolCalls.values()) {
      clearTimeout(timer);
      reject(new Error("oracle client closed"));
    }
    this.pendingToolCalls.clear();
    this.rl?.close();
    this.connected = false;
  }

  // ─── Registration ─────────────────────────────────────────────────────

  onDecisionRequest(handler: DecisionRequestHandler): void {
    if (this.decisionHandler) {
      throw new Error("decision handler already registered; only one Pythia per client");
    }
    this.decisionHandler = handler;
  }

  // ─── Outgoing ─────────────────────────────────────────────────────────

  sendToolCall(call: Omit<ToolCall, "kind" | "callId">): Promise<ToolResult> {
    const callId = randomUUID();
    const full = { kind: "tool_call", callId, ...call } as ToolCall;
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingToolCalls.delete(callId);
        reject(new Error(`tool call ${full.tool} timed out after ${TOOL_CALL_TIMEOUT_MS}ms`));
      }, TOOL_CALL_TIMEOUT_MS);
      this.pendingToolCalls.set(callId, { resolve, reject, timer });
      this.send(full);
    });
  }

  sendDecisionResponse(resp: DecisionResponse): void {
    this.send(resp);
  }

  sendSessionEnd(end: Omit<SessionEnd, "kind">): void {
    this.send({ kind: "session_end", ...end } as SessionEnd);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private send(msg: OracleMessage): void {
    if (!this.connected) throw new Error("oracle client not connected");
    const frame = JSON.stringify(msg);
    process.stdout.write(frame + "\n");
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      this.log(`[oracle] malformed json on stdin: ${(e as Error).message}`);
      return;
    }
    const result = OracleMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.log(`[oracle] schema-invalid frame: ${result.error.message}`);
      return;
    }
    this.dispatch(result.data);
  }

  private dispatch(msg: OracleMessage): void {
    switch (msg.kind) {
      case "handshake":
        this.hexcoreVersion = msg.hexcoreVersion;
        this.handshakeReceived = true;
        this.log(`[oracle] handshake ok — hexcore ${msg.hexcoreVersion}`);
        break;
      case "decision_request":
        void this.handleDecisionRequest(msg);
        break;
      case "tool_result": {
        const pending = this.pendingToolCalls.get(msg.callId);
        if (!pending) {
          this.log(`[oracle] stray tool_result for callId ${msg.callId}`);
          return;
        }
        clearTimeout(pending.timer);
        this.pendingToolCalls.delete(msg.callId);
        pending.resolve(msg);
        break;
      }
      case "session_end":
        this.log(`[oracle] session ended: ${msg.reason}`);
        break;
      // tool_call and decision_response are outbound only.
      default:
        this.log(`[oracle] unexpected inbound frame kind: ${(msg as { kind: string }).kind}`);
    }
  }

  private async handleDecisionRequest(req: DecisionRequest): Promise<void> {
    if (!this.decisionHandler) {
      // Fallthrough: continue policy.
      this.send({
        kind: "decision_response",
        eventId: req.eventId,
        action: "continue",
        reasoning: "no handler registered",
      });
      return;
    }
    try {
      const resp = await this.decisionHandler(req);
      this.send(resp);
    } catch (e) {
      this.log(`[oracle] handler threw: ${(e as Error).message}`);
      this.send({
        kind: "decision_response",
        eventId: req.eventId,
        action: "continue",
        reasoning: `handler error: ${(e as Error).message}`,
      });
    }
  }

  private awaitHandshake(): Promise<Handshake> {
    return new Promise<Handshake>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (this.handshakeReceived) {
          resolve({
            kind: "handshake",
            protocolVersion: 1,
            hexcoreVersion: this.hexcoreVersion,
            pythiaVersion: this.config.pythiaVersion,
            capabilities: this.config.capabilities,
          });
          return;
        }
        if (Date.now() - start > HANDSHAKE_TIMEOUT_MS) {
          reject(new Error(`handshake timeout after ${HANDSHAKE_TIMEOUT_MS}ms`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  getHexcoreVersion(): string {
    return this.hexcoreVersion;
  }
}
