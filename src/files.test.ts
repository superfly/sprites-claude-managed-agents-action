import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { parseFiles, pullFiles, uploadFiles } from "./files.js";

import type { SpriteFilesystem } from "@fly/sprites";

const s3 = vi.hoisted(() => {
  class Command {
    constructor(public input: { Key: string; Body?: string }) {}
  }
  const send = vi.fn<(command: Command) => Promise<unknown>>();
  return {
    GetObjectCommand: class extends Command {},
    HeadObjectCommand: class extends Command {},
    PutObjectCommand: class extends Command {},
    S3Client: class {
      send = send;
    },
    send,
    getSignedUrl: async (_s3: unknown, command: Command) =>
      `https://signed/${command.input.Key}`,
  };
});

vi.mock("@aws-sdk/client-s3", () => s3);
vi.mock("@aws-sdk/s3-request-presigner", () => s3);
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: async (path: string) => Buffer.from(path),
  writeFile: vi.fn(),
}));

const A =
  "blobs/ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
const B =
  "blobs/3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d";

const upload = async () =>
  uploadFiles(
    [
      ["a", "/a"],
      ["b", "/b"],
    ],
    "bucket",
    {},
    { labels: "prod" },
  );

describe("uploadFiles", () => {
  it("uploads missing blobs and the metadata", async () => {
    s3.send.mockImplementation(async (command) => {
      if (command instanceof s3.HeadObjectCommand && command.input.Key === A) {
        throw new Error("Forbidden");
      }
    });

    const url = await upload();

    const puts = s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof s3.PutObjectCommand);
    const metadata = puts[1].input.Body ?? "";
    const key = `metadata/${createHash("sha256").update(metadata).digest("hex")}`;
    expect(url).toBe(`https://signed/${key}`);
    expect(puts.map((command) => command.input.Key)).toEqual([A, key]);
    expect(JSON.parse(metadata)).toEqual({
      labels: "prod",
      files: JSON.stringify({
        "/a": `https://signed/${A}`,
        "/b": `https://signed/${B}`,
      }),
    });
  });

  it("reports which file failed", async () => {
    s3.send.mockRejectedValue(new Error("denied"));

    await expect(upload()).rejects.toThrow("failed to upload a: denied");
  });
});

const pull = async (readFile: (path: string) => Promise<Buffer>) =>
  pullFiles(
    [
      ["out/a.txt", "/a.txt"],
      ["b.txt", "/b.txt"],
    ],
    { readFile } as unknown as SpriteFilesystem,
  );

describe("pullFiles", () => {
  it("writes each file locally", async () => {
    await pull(async (path) => Buffer.from(path));

    expect(mkdir).toHaveBeenCalledWith("out", { recursive: true });
    expect(writeFile).toHaveBeenCalledWith("out/a.txt", Buffer.from("/a.txt"));
    expect(writeFile).toHaveBeenCalledWith("b.txt", Buffer.from("/b.txt"));
  });

  it("reports which file failed", async () => {
    await expect(
      pull(async (path) => {
        if (path === "/b.txt") throw new Error("not found");
        return Buffer.from(path);
      }),
    ).rejects.toThrow("failed to pull /b.txt: not found");
  });
});

describe("parseFiles", () => {
  it("parses file mounts", () => {
    expect(parseFiles("  a.sh /a.sh\n\nb/c.sh   /mnt/my  c.sh \n")).toEqual([
      ["a.sh", "/a.sh"],
      ["b/c.sh", "/mnt/my  c.sh"],
    ]);
  });

  it("allows spaces in either path", () => {
    expect(parseFiles("my file.sh /my file.sh\n/home/a b/c.sh /c.sh")).toEqual([
      ["my file.sh", "/my file.sh"],
      ["/home/a b/c.sh", "/c.sh"],
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(parseFiles("")).toEqual([]);
  });

  it("requires an absolute session path", () => {
    expect(() => parseFiles("lonely")).toThrow(
      'expected "<local path> /<session path>", got "lonely"',
    );
    expect(() => parseFiles("a.sh a.sh")).toThrow(/got "a.sh a.sh"/);
  });
});
