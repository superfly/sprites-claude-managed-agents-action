import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Transcript, formatToolInput } from "./transcript.js";

import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";

vi.mock("@actions/core");

let log: string[];

beforeEach(() => {
  log = [];
  vi.mocked(core.info).mockImplementation((line) => log.push(line));
  vi.mocked(core.startGroup).mockImplementation((name) =>
    log.push(`::group::${name}`),
  );
  vi.mocked(core.endGroup).mockImplementation(() => log.push("::endgroup::"));
});

const output = () => {
  const tokens = new Map<string, string>();
  return log
    .join("\n")
    .replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, (token) => {
      const name = tokens.get(token) ?? `<token${tokens.size + 1}>`;
      tokens.set(token, name);
      return name;
    })
    .replaceAll("\x1b[1m", "<b>")
    .replaceAll("\x1b[3m", "<i>")
    .replaceAll("\x1b[0m", "<reset>");
};

const render = (...events: Array<Record<string, unknown>>) => {
  const transcript = new Transcript();
  for (const event of events) {
    transcript.render(event as unknown as BetaManagedAgentsSessionEvent);
  }
  return transcript.text;
};

const text = (value: string) => [{ type: "text", text: value }];

describe("formatToolInput", () => {
  it("formats each tool", () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["bash", { command: "ls -la" }],
      ["edit", { file_path: "/a", old_string: "x\ny", new_string: "z" }],
      ["grep", { path: "src", pattern: "foo" }],
      ["read", { file_path: "/a", view_range: [1, 9] }],
      ["read", { file_path: "/a" }],
      ["web_fetch", { url: "https://fly.io" }],
      ["write", { file_path: "/a", content: "hi" }],
      ["mystery", { a: 1 }],
    ];
    expect(
      calls
        .map(([name, input]) => `${name}: ${formatToolInput(name, input)}`)
        .join("\n"),
    ).toMatchInlineSnapshot(`
      "bash: ls -la
      edit: /a
      - x
      - y
      + z
      grep: src foo
      read: /a:1-9
      read: /a
      web_fetch: https://fly.io
      write: /a
      hi
      mystery: 
      {"a":1}"
    `);
  });
});

describe("Transcript", () => {
  it("renders a transcript", () => {
    const transcript = render(
      { type: "user.message", content: text("fix it\nplease") },
      { type: "agent.thinking" },
      { type: "agent.message", content: text("On it.\n") },
      {
        type: "agent.tool_use",
        id: "sevt_1",
        name: "write",
        input: { file_path: "/a.sh", content: "echo hi\n" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "sevt_1",
        content: text("wrote 8 bytes"),
      },
    );

    expect(transcript).toMatchInlineSnapshot(`
      "> fix it
      > please

      On it.

      * write /a.sh
        echo hi

        wrote 8 bytes

      "
    `);
    expect(output()).toMatchInlineSnapshot(`
      "<i>Thinking...<reset>
      ::stop-commands::<token1>
      <reset>On it.
      ::<token1>::
      ::group::<b>write<reset> /a.sh
      ::stop-commands::<token2>
      echo hi
      wrote 8 bytes
      ::<token2>::
      ::endgroup::"
    `);
  });

  it("renders an outcome", () => {
    const transcript = render(
      { type: "user.define_outcome", description: "fix it" },
      {
        type: "span.outcome_evaluation_end",
        result: "needs_revision",
        explanation: "it does not work",
      },
    );

    expect(transcript).toMatchInlineSnapshot(`
      "> fix it

      * evaluation needs_revision

        it does not work

      "
    `);
    expect(output()).toMatchInlineSnapshot(`
      "::group::<b>evaluation<reset> needs_revision
      ::stop-commands::<token1>
      it does not work
      ::<token1>::
      ::endgroup::"
    `);
  });

  it("stops workflow commands in tool output", () => {
    render(
      { type: "agent.tool_use", id: "1", name: "bash", input: {} },
      {
        type: "agent.tool_result",
        tool_use_id: "1",
        content: text("::add-mask::secret"),
      },
    );

    expect(output()).toMatchInlineSnapshot(`
      "::group::<b>bash<reset> 
      ::stop-commands::<token1>
      ::add-mask::secret
      ::<token1>::
      ::endgroup::"
    `);
  });

  it("renders MCP tool results", () => {
    const transcript = render(
      {
        type: "agent.mcp_tool_use",
        id: "1",
        name: "lookup",
        input: { q: "x" },
      },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "1", content: [] },
    );

    expect(transcript).toMatchInlineSnapshot(`
      "* lookup 
        {"q":"x"}

      "
    `);
  });
});
