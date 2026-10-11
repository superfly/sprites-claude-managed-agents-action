import * as core from "@actions/core";
import { setTimeout as sleep } from "node:timers/promises";

import { explain, messageOf } from "./errors.js";

import type { Anthropic } from "@anthropic-ai/sdk";
import type {
  BetaManagedAgentsEventParams,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

import type { Transcript } from "./transcript.js";

const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECTS = 5;

export function spriteName(sessionId: string): string {
  const slug = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `claude-agent-${slug}`;
}

async function* events(
  client: Anthropic,
  sessionId: string,
  signal: AbortSignal,
  stream: AsyncIterable<BetaManagedAgentsStreamSessionEvents>,
): AsyncGenerator<BetaManagedAgentsSessionEvent> {
  let last: string | undefined;
  async function* replay() {
    const live = await client.beta.sessions.events.stream(
      sessionId,
      {},
      { signal },
    );
    try {
      yield* client.beta.sessions.events.list(
        sessionId,
        last ? { "created_at[gte]": last } : {},
        { signal },
      );
      yield* live;
    } finally {
      live.controller.abort();
    }
  }

  const seen = new Set<string>();
  for (let source = stream, failures = 0; ; source = replay()) {
    try {
      for await (const event of source) {
        if (!("processed_at" in event) || event.processed_at == null) continue;
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        last = event.processed_at;
        failures = 0;
        yield event;
      }
    } catch (error) {
      if (signal.aborted || ++failures > MAX_RECONNECTS) throw error;
      core.info(`Reconnecting to session ${sessionId}: ${messageOf(error)}`);
    }
    await sleep(RECONNECT_DELAY_MS, undefined, { signal });
  }
}

export async function runTurn(
  client: Anthropic,
  sessionId: string,
  kickoff: BetaManagedAgentsEventParams,
  timeoutSeconds: number,
  transcript: Transcript,
): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1000);
  let evaluation: string | undefined;

  try {
    const stream = await client.beta.sessions.events.stream(
      sessionId,
      {},
      { signal },
    );
    await explain(
      client.beta.sessions.events.send(sessionId, {
        events: [kickoff],
      }),
      `failed to start session ${sessionId}`,
    );

    for await (const event of events(client, sessionId, signal, stream)) {
      switch (event.type) {
        case "session.status_idle":
          if (event.stop_reason.type === "end_turn") {
            if (
              kickoff.type === "user.define_outcome" &&
              evaluation !== "satisfied"
            ) {
              throw new Error(
                `session ${sessionId} did not satisfy the outcome: ${evaluation ?? "not evaluated"}`,
              );
            }
            return;
          }
          if (event.stop_reason.type !== "requires_action") {
            throw new Error(
              `session ${sessionId} stopped: ${event.stop_reason.type}`,
            );
          }
          break;
        case "session.status_terminated":
          throw new Error(`session ${sessionId} terminated`);
        case "session.deleted":
          throw new Error(`session ${sessionId} was deleted`);
        case "span.outcome_evaluation_end":
          evaluation = event.result;
          break;
        case "session.error":
          core.warning(`${event.error.type}: ${event.error.message}`);
          break;
        case "agent.custom_tool_use":
          throw new Error(
            `session ${sessionId} called the custom tool ${event.name}, which this action cannot answer`,
          );
        case "agent.tool_use":
        case "agent.mcp_tool_use":
          if (event.evaluated_permission === "ask") {
            await client.beta.sessions.events.send(sessionId, {
              events: [
                {
                  type: "user.tool_confirmation",
                  tool_use_id: event.id,
                  result: "deny",
                  deny_message: `No one is available to approve ${event.name} in session ${sessionId}.`,
                },
              ],
            });
          }
          break;
      }
      transcript.render(event);
    }
  } catch (error) {
    await client.beta.sessions.events
      .send(
        sessionId,
        { events: [{ type: "user.interrupt" }] },
        { timeout: 10_000, maxRetries: 0 },
      )
      .catch(() => {});
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  throw new Error(`session ${sessionId} timed out after ${timeoutSeconds}s`);
}
