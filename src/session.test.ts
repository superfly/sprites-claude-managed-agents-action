import { describe, expect, it, vi } from "vitest";

import { runTurn, spriteName } from "./session.js";
import { Transcript } from "./transcript.js";

import type { Anthropic } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";

vi.mock("@actions/core");

type Script = Array<Record<string, unknown> | Error>;
type FakeClient = Anthropic & { sent: Array<Record<string, unknown>> };

async function* play(script: Script) {
  for (const event of script) {
    if (event instanceof Error) throw event;
    yield { processed_at: "now", ...event };
  }
}

function fakeClient(...streams: Script[]): FakeClient {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    sent,
    beta: {
      sessions: {
        events: {
          send: async (
            _id: string,
            body: { events: Array<Record<string, unknown>> },
          ) => sent.push(...body.events),
          list: () => play([]),
          stream: async () =>
            Object.assign(play(streams.shift() ?? []), {
              controller: new AbortController(),
            }),
        },
      },
    },
  };
  return client as unknown as FakeClient;
}

const prompt: BetaManagedAgentsEventParams = {
  type: "user.message",
  content: [{ type: "text", text: "go" }],
};

const outcome: BetaManagedAgentsEventParams = {
  type: "user.define_outcome",
  description: "fix it",
  rubric: { type: "text", content: "- it works" },
};

async function turn(client: FakeClient, timeoutSeconds = 5, kickoff = prompt) {
  const transcript = new Transcript();
  await runTurn(client, "s", kickoff, timeoutSeconds, transcript);
  return transcript.text;
}

const idle = (id: string) => ({
  id,
  type: "session.status_idle",
  stop_reason: { type: "end_turn" },
});

const evaluation = (id: string, result: string) => ({
  id,
  type: "span.outcome_evaluation_end",
  result,
  explanation: "graded",
});

const message = (id: string, text: string) => ({
  id,
  type: "agent.message",
  content: [{ type: "text", text }],
});

describe("spriteName", () => {
  it("derives the sprite name from the session id", () => {
    expect(spriteName("sesn_011CZxAbc123Def456")).toBe(
      "claude-agent-sesn-011czxabc123def456",
    );
    expect(spriteName("--Foo..Bar--")).toBe("claude-agent-foo-bar");
    expect(spriteName("x".repeat(50))).toBe(`claude-agent-${"x".repeat(40)}`);
  });
});

describe("runTurn", () => {
  it("returns the transcript at end_turn", async () => {
    const client = fakeClient([
      {
        id: "1",
        type: "agent.message",
        content: [{ type: "text", text: "done" }],
      },
      {
        id: "2",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ]);
    expect(await turn(client)).toBe("done\n\n");
    expect(client.sent[0]).toEqual({
      type: "user.message",
      content: [{ type: "text", text: "go" }],
    });
  });

  it("skips queued and duplicate events", async () => {
    const sent = { id: "1", ...prompt };
    const client = fakeClient([
      { ...sent, processed_at: null },
      sent,
      sent,
      {
        id: "2",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ]);
    expect(await turn(client)).toBe("> go\n\n");
  });

  it("denies tool calls that need approval", async () => {
    const client = fakeClient([
      {
        id: "1",
        type: "agent.tool_use",
        name: "bash",
        input: {},
        evaluated_permission: "ask",
      },
      {
        id: "2",
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      },
      {
        id: "3",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
      },
    ]);
    await turn(client);
    expect(client.sent.map((event) => [event.type, event.result])).toEqual([
      ["user.message", undefined],
      ["user.tool_confirmation", "deny"],
    ]);
  });

  it("fails on custom tool calls", async () => {
    const client = fakeClient([
      { id: "1", type: "agent.custom_tool_use", name: "mine", input: {} },
    ]);
    await expect(turn(client)).rejects.toThrow(/custom tool mine/);
  });

  it("fails when the budget is reached", async () => {
    const client = fakeClient([
      {
        id: "1",
        type: "session.status_idle",
        stop_reason: { type: "budget_reached" },
      },
    ]);
    await expect(turn(client)).rejects.toThrow(
      "session s stopped: budget_reached",
    );
    expect(client.sent.at(-1)).toEqual({ type: "user.interrupt" });
  });

  it("works toward an outcome until it is satisfied", async () => {
    const client = fakeClient([
      evaluation("1", "needs_revision"),
      evaluation("2", "satisfied"),
      idle("3"),
    ]);
    await turn(client, 5, outcome);
    expect(client.sent).toEqual([outcome]);
  });

  it.each([
    [
      [evaluation("1", "max_iterations_reached"), idle("2")],
      "max_iterations_reached",
    ],
    [[idle("1")], "not evaluated"],
  ])("fails when the outcome is unsatisfied", async (script, result) => {
    const client = fakeClient(script);
    await expect(turn(client, 5, outcome)).rejects.toThrow(
      `session s did not satisfy the outcome: ${result}`,
    );
  });

  it("fails when the session terminates", async () => {
    const client = fakeClient([{ id: "1", type: "session.status_terminated" }]);
    await expect(turn(client)).rejects.toThrow("session s terminated");
  });

  it("reconnects and replays missed events after a dropped stream", async () => {
    const client = fakeClient(
      [message("1", "a"), new Error("socket hang up")],
      [
        {
          id: "3",
          type: "session.status_idle",
          stop_reason: { type: "end_turn" },
        },
      ],
    );
    const list = vi.fn(() => play([message("1", "a"), message("2", "b")]));
    client.beta.sessions.events.list = list as never;

    expect(await turn(client)).toBe("a\n\nb\n\n");
    expect(list).toHaveBeenCalledWith(
      "s",
      { "created_at[gte]": "now" },
      expect.anything(),
    );
  });

  it("interrupts the session when it times out", async () => {
    const client = fakeClient([]);
    await expect(turn(client, 0.2)).rejects.toThrow(
      "session s timed out after 0.2s",
    );
    expect(client.sent.at(-1)).toEqual({ type: "user.interrupt" });
  });
});
