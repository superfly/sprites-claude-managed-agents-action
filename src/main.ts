import * as core from "@actions/core";
import { Anthropic } from "@anthropic-ai/sdk";
import { SpritesClient } from "@fly/sprites";

import { explain, messageOf } from "./errors.js";
import { parseFiles, pullFiles, uploadFiles } from "./files.js";
import { runTurn, spriteName } from "./session.js";
import { Transcript } from "./transcript.js";

import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { S3ClientConfig } from "@aws-sdk/client-s3";

const MAX_TIMEOUT = Math.floor((2 ** 31 - 1) / 1000);

function positiveInteger(name: string): string | undefined {
  const value = core.getInput(name);
  if (value && !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return value || undefined;
}

export async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("api-key", { required: true });
    const agent = core.getInput("agent-id", { required: true });
    const environment = core.getInput("environment-id", { required: true });
    const prompt = core.getInput("prompt");
    const outcome = core.getInput("outcome");
    if (!prompt === !outcome) {
      throw new Error("set exactly one of prompt or outcome");
    }
    const rubric = core.getInput("rubric", { required: outcome !== "" });
    const maxIterations = positiveInteger("max-iterations");
    const title = core.getInput("title");
    const labels = core.getInput("labels");
    const budget = positiveInteger("budget-cents");
    const timeout = Number(positiveInteger("timeout") ?? 1800);
    if (timeout > MAX_TIMEOUT) {
      throw new Error(`timeout must be at most ${MAX_TIMEOUT} seconds`);
    }
    const archiveSession = core.getBooleanInput("archive-session");
    const deleteSprite = core.getBooleanInput("delete-sprite");
    const cleanupOnError = core.getBooleanInput("cleanup-on-error");
    if (deleteSprite && !archiveSession) {
      throw new Error("delete-sprite requires archive-session");
    }
    const pulls = parseFiles(core.getInput("pull-files"));
    const spriteToken = core.getInput("sprite-token", {
      required: deleteSprite || pulls.length > 0,
    });
    const mounts = parseFiles(core.getInput("files"));
    const bucket = core.getInput("bucket", { required: mounts.length > 0 });
    const s3: S3ClientConfig = {
      endpoint: core.getInput("aws-endpoint-url"),
      region: core.getInput("aws-region"),
      credentials: {
        accessKeyId: core.getInput("aws-access-key-id", {
          required: mounts.length > 0,
        }),
        secretAccessKey: core.getInput("aws-secret-access-key", {
          required: mounts.length > 0,
        }),
      },
    };

    const inline: Record<string, string> = labels ? { labels } : {};
    const metadata =
      mounts.length > 0
        ? { metadata: await uploadFiles(mounts, bucket, s3, inline) }
        : inline;

    const client = new Anthropic({ apiKey });
    const session = await explain(
      client.beta.sessions.create({
        agent,
        environment_id: environment,
        title,
        ...(Object.keys(metadata).length > 0 && { metadata }),
        ...(budget && {
          budget: {
            type: "limit",
            max_list_cost: { amount: budget, currency: "USD" },
          },
        }),
      }),
      "failed to create a session",
    );
    const sprite = spriteName(session.id);
    core.setOutput("session-id", session.id);
    core.setOutput("sprite", sprite);
    core.info(`Created session ${session.id} in Sprite ${sprite}`);

    const sprites = new SpritesClient(spriteToken);
    async function cleanup() {
      if (archiveSession) {
        await explain(
          client.beta.sessions.archive(session.id),
          `failed to archive session ${session.id}`,
        );
        core.info(`Archived session ${session.id}`);
      }
      if (deleteSprite) {
        await explain(
          sprites.deleteSprite(sprite),
          `failed to delete Sprite ${sprite}`,
        );
        core.info(`Deleted Sprite ${sprite}`);
      }
    }

    const kickoff: BetaManagedAgentsEventParams = outcome
      ? {
          type: "user.define_outcome",
          description: outcome,
          rubric: { type: "text", content: rubric },
          ...(maxIterations && { max_iterations: Number(maxIterations) }),
        }
      : { type: "user.message", content: [{ type: "text", text: prompt }] };
    const transcript = new Transcript();
    try {
      await runTurn(client, session.id, kickoff, timeout, transcript);
      if (pulls.length > 0) {
        await pullFiles(pulls, sprites.sprite(sprite).filesystem());
        core.info(`Pulled ${pulls.length} files from Sprite ${sprite}`);
      }
    } catch (error) {
      if (cleanupOnError) {
        await cleanup().catch((cleanupError: unknown) =>
          core.warning(messageOf(cleanupError)),
        );
      }
      throw error;
    } finally {
      core.setOutput("transcript", transcript.text);
    }
    await cleanup();
  } catch (error) {
    core.setFailed(messageOf(error));
  }
}
