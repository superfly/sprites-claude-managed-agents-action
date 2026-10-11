import * as core from "@actions/core";
import { randomUUID } from "node:crypto";

import type {
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsSessionEvent,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

type ToolUse =
  | BetaManagedAgentsAgentToolUseEvent
  | BetaManagedAgentsAgentMCPToolUseEvent;

const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";

function textOf(
  content: ReadonlyArray<{ type: string; text?: string }> | undefined,
): string {
  return (content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
    .join("\n\n")
    .replace(/\n+$/, "");
}

const str = (value: unknown): string =>
  value == null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);

export function formatToolInput(
  name: string,
  input: Record<string, unknown>,
): string {
  switch (name) {
    case "bash":
      return str(input.command);
    case "edit": {
      const removed = str(input.old_string).replaceAll("\n", "\n- ");
      const added = str(input.new_string).replaceAll("\n", "\n+ ");
      return `${str(input.file_path)}\n- ${removed}\n+ ${added}`;
    }
    case "glob":
    case "grep":
      return `${str(input.path)} ${str(input.pattern)}`;
    case "read": {
      const range = input.view_range;
      return Array.isArray(range)
        ? `${str(input.file_path)}:${range.map(str).join("-")}`
        : str(input.file_path);
    }
    case "web_fetch":
      return str(input.url);
    case "web_search":
      return str(input.query);
    case "write":
      return `${str(input.file_path)}\n${str(input.content)}`;
    default:
      return `\n${JSON.stringify(input)}`;
  }
}

function untrusted(text: string): void {
  const token = randomUUID();
  core.info(`::stop-commands::${token}\n${text}\n::${token}::`);
}

function indent(text: string): string {
  return text.replace(/^(?=.)/gm, "  ");
}

export class Transcript {
  #calls = new Map<string, ToolUse>();
  text = "";

  render(event: BetaManagedAgentsSessionEvent): void {
    switch (event.type) {
      case "agent.thinking":
        core.info(`${ITALIC}Thinking...${RESET}`);
        break;
      case "agent.message": {
        const text = textOf(event.content);
        // RESET prefix on every line, including blank ones, stops GitHub's log
        // viewer from folding them.
        untrusted(text.replace(/^/gm, RESET));
        this.text += `${text}\n\n`;
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        this.#calls.set(event.id, event);
        break;
      case "agent.tool_result":
      case "agent.mcp_tool_result":
        this.#renderResult(
          this.#calls.get(
            "tool_use_id" in event ? event.tool_use_id : event.mcp_tool_use_id,
          ),
          event.content,
        );
        break;
      case "user.message":
        this.text += `${textOf(event.content).replace(/^/gm, "> ")}\n\n`;
        break;
      case "user.define_outcome":
        this.text += `${event.description.replace(/^/gm, "> ")}\n\n`;
        break;
      case "span.outcome_evaluation_end":
        core.startGroup(`${BOLD}evaluation${RESET} ${event.result}`);
        untrusted(event.explanation);
        core.endGroup();
        this.text += `* evaluation ${event.result}\n\n${indent(event.explanation)}\n\n`;
        break;
    }
  }

  #renderResult(
    call: ToolUse | undefined,
    content: ReadonlyArray<{ type: string; text?: string }> | undefined,
  ): void {
    const tool = call?.name ?? "unknown";
    const [title, ...rest] = formatToolInput(tool, call?.input ?? {})
      .replace(/\n+$/, "")
      .split("\n");
    const text = textOf(content);

    core.startGroup(`${BOLD}${tool}${RESET} ${title}`);
    untrusted([...rest, text].join("\n"));
    core.endGroup();

    const summary = [`* ${tool} ${title}`, ...rest.map(indent)].join("\n");
    const output = text ? `\n${indent(text)}\n` : "";
    this.text += `${summary}\n${output}\n`;
  }
}
