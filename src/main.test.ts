import * as core from "@actions/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pullFiles, uploadFiles } from "./files.js";
import { run } from "./main.js";
import { runTurn, spriteName } from "./session.js";
import { Transcript } from "./transcript.js";

const { archive, create, deleteSprite, filesystem } = vi.hoisted(() => ({
  archive: vi.fn(),
  create: vi.fn(),
  deleteSprite: vi.fn(),
  filesystem: {},
}));

vi.mock("@actions/core");
vi.mock("@anthropic-ai/sdk", () => ({
  Anthropic: class {
    beta = { sessions: { archive, create } };
  },
}));
vi.mock("@fly/sprites", () => ({
  SpritesClient: class {
    deleteSprite = deleteSprite;
    sprite = () => ({ filesystem: () => filesystem });
  },
}));
vi.mock("./files.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./files.js")>()),
  pullFiles: vi.fn(),
  uploadFiles: vi.fn(),
}));
vi.mock("./session.js");

let inputs: Record<string, string>;

describe("run", () => {
  beforeEach(() => {
    inputs = {
      "agent-id": "agent",
      "environment-id": "env",
      "api-key": "key",
      title: "superfly/example#1",
      prompt: "go",
      "budget-cents": "300",
      files: "",
      "aws-endpoint-url": "https://t3.storage.dev",
      "aws-region": "auto",
      timeout: "1800",
    };
    vi.mocked(core.getInput).mockImplementation((name, options) => {
      const value = inputs[name] ?? "";
      if (options?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    });
    vi.mocked(core.getBooleanInput).mockImplementation(
      (name) => inputs[name] === "true",
    );
    create.mockResolvedValue({ id: "sesn_1" });
    archive.mockResolvedValue({});
    deleteSprite.mockResolvedValue(undefined);
    vi.mocked(spriteName).mockReturnValue("claude-agent-sesn-1");
    vi.mocked(runTurn).mockImplementation(
      async (_client, _id, _prompt, _timeout, transcript) => {
        transcript.text = "transcript";
      },
    );
  });

  it("sets the outputs", async () => {
    await run();

    expect(uploadFiles).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      agent: "agent",
      environment_id: "env",
      title: "superfly/example#1",
      budget: {
        type: "limit",
        max_list_cost: { amount: "300", currency: "USD" },
      },
    });
    expect(runTurn).toHaveBeenCalledWith(
      expect.anything(),
      "sesn_1",
      { type: "user.message", content: [{ type: "text", text: "go" }] },
      1800,
      expect.any(Transcript),
    );
    expect(vi.mocked(core.setOutput).mock.calls).toEqual([
      ["session-id", "sesn_1"],
      ["sprite", "claude-agent-sesn-1"],
      ["transcript", "transcript"],
    ]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("defines an outcome", async () => {
    inputs.prompt = "";
    inputs.outcome = "fix it";
    inputs.rubric = "- it works";
    inputs["max-iterations"] = "5";

    await run();

    expect(runTurn).toHaveBeenCalledWith(
      expect.anything(),
      "sesn_1",
      {
        type: "user.define_outcome",
        description: "fix it",
        rubric: { type: "text", content: "- it works" },
        max_iterations: 5,
      },
      1800,
      expect.any(Transcript),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["both", "fix it"],
    ["neither", ""],
  ])("rejects %s of prompt and outcome", async (_name, outcome) => {
    inputs.prompt = outcome && "go";
    inputs.outcome = outcome;
    inputs.rubric = "- it works";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "set exactly one of prompt or outcome",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("requires a rubric for an outcome", async () => {
    inputs.prompt = "";
    inputs.outcome = "fix it";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "Input required and not supplied: rubric",
    );
  });

  it("labels the Sprite", async () => {
    inputs.labels = "prod,team-x";

    await run();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { labels: "prod,team-x" } }),
    );
  });

  it("uploads the session files", async () => {
    inputs.bucket = "bucket";
    inputs["aws-access-key-id"] = "id";
    inputs["aws-secret-access-key"] = "secret";
    inputs.files = "a.sh /a.sh";
    inputs.labels = "prod,team-x";
    vi.mocked(uploadFiles).mockResolvedValue("https://example.com/metadata");

    await run();

    expect(uploadFiles).toHaveBeenCalledWith(
      [["a.sh", "/a.sh"]],
      "bucket",
      {
        endpoint: "https://t3.storage.dev",
        region: "auto",
        credentials: { accessKeyId: "id", secretAccessKey: "secret" },
      },
      { labels: "prod,team-x" },
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { metadata: "https://example.com/metadata" },
      }),
    );
  });

  it("requires a bucket for files", async () => {
    inputs.files = "a.sh /a.sh";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "Input required and not supplied: bucket",
    );
  });

  it("requires credentials for files", async () => {
    inputs.bucket = "bucket";
    inputs.files = "a.sh /a.sh";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "Input required and not supplied: aws-access-key-id",
    );
  });

  it("archives the session and deletes the sprite", async () => {
    inputs["archive-session"] = "true";
    inputs["delete-sprite"] = "true";
    inputs["sprite-token"] = "token";

    await run();

    expect(archive).toHaveBeenCalledWith("sesn_1");
    expect(deleteSprite).toHaveBeenCalledWith("claude-agent-sesn-1");
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("pulls files from the sprite", async () => {
    inputs["pull-files"] = "out.txt /out.txt";
    inputs["sprite-token"] = "token";

    await run();

    expect(pullFiles).toHaveBeenCalledWith(
      [["out.txt", "/out.txt"]],
      filesystem,
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["delete-sprite", { "archive-session": "true", "delete-sprite": "true" }],
    ["pull-files", { "pull-files": "out.txt /out.txt" }],
  ])("requires a sprite token for %s", async (_name, extra) => {
    Object.assign(inputs, extra);

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "Input required and not supplied: sprite-token",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("requires archive-session to delete the sprite", async () => {
    inputs["delete-sprite"] = "true";
    inputs["sprite-token"] = "token";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "delete-sprite requires archive-session",
    );
  });

  it("leaves the session and sprite after a failed turn", async () => {
    inputs["pull-files"] = "out.txt /out.txt";
    inputs["archive-session"] = "true";
    inputs["delete-sprite"] = "true";
    inputs["sprite-token"] = "token";
    vi.mocked(runTurn).mockRejectedValue(new Error("terminated"));

    await run();

    expect(pullFiles).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(deleteSprite).not.toHaveBeenCalled();
  });

  it("cleans up after a failed turn when asked", async () => {
    inputs["archive-session"] = "true";
    inputs["delete-sprite"] = "true";
    inputs["cleanup-on-error"] = "true";
    inputs["sprite-token"] = "token";
    vi.mocked(runTurn).mockRejectedValue(new Error("terminated"));
    archive.mockRejectedValue(new Error("busy"));

    await run();

    expect(core.warning).toHaveBeenCalledWith(
      "failed to archive session sesn_1: busy",
    );
    expect(core.setFailed).toHaveBeenCalledWith("terminated");
  });

  it("rejects a malformed budget", async () => {
    inputs["budget-cents"] = "3.00";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      'budget-cents must be a positive integer, got "3.00"',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("defaults an empty timeout", async () => {
    inputs.timeout = "";

    await run();

    expect(runTurn).toHaveBeenCalledWith(
      expect.anything(),
      "sesn_1",
      { type: "user.message", content: [{ type: "text", text: "go" }] },
      1800,
      expect.any(Transcript),
    );
  });

  it("rejects a timeout too long for a timer", async () => {
    inputs.timeout = "2147484";

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "timeout must be at most 2147483 seconds",
    );
  });

  it("explains a failed session", async () => {
    create.mockRejectedValue(new Error("401"));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith(
      "failed to create a session: 401",
    );
  });

  it("keeps the transcript of a failed turn", async () => {
    vi.mocked(runTurn).mockImplementation(
      async (_client, _id, _prompt, _timeout, transcript) => {
        transcript.text = "partial";
        throw new Error("session sesn_1 terminated");
      },
    );

    await run();

    expect(core.setOutput).toHaveBeenCalledWith("transcript", "partial");
    expect(core.setFailed).toHaveBeenCalledWith("session sesn_1 terminated");
  });
});
