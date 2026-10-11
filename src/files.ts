import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { explain } from "./errors.js";

import type { S3ClientConfig } from "@aws-sdk/client-s3";
import type { SpriteFilesystem } from "@fly/sprites";

export type Mount = [local: string, path: string];

const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export function parseFiles(files: string): Mount[] {
  return files.split("\n").flatMap((line): Mount[] => {
    line = line.trim();
    if (!line) return [];
    const [, local, path] = line.match(/^(.+?)\s+(\/.*)$/) ?? [];
    if (!local || !path) {
      throw new Error(`expected "<local path> /<session path>", got "${line}"`);
    }
    return [[local, path]];
  });
}

export async function uploadFiles(
  mounts: Mount[],
  bucket: string,
  config: S3ClientConfig,
  extra: Record<string, string> = {},
): Promise<string> {
  const s3 = new S3Client(config);
  const put = async (Key: string, Body: string | Buffer) =>
    s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body }));
  const presign = async (Key: string) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key }), {
      // The Sprite fetches files on session start. 10 minutes seems like a
      // reasonable amount to wait for that.
      expiresIn: 600,
    });
  const upload = async (local: string) => {
    const body = await readFile(local);
    const blob = `blobs/${sha256(body)}`;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: blob }));
    } catch {
      await put(blob, body);
    }
    return presign(blob);
  };

  const urls = await Promise.all(
    mounts.map(async ([local, path]) => [
      path,
      await explain(upload(local), `failed to upload ${local}`),
    ]),
  );

  const metadata = JSON.stringify({
    ...extra,
    files: JSON.stringify(Object.fromEntries(urls)),
  });
  const key = `metadata/${sha256(metadata)}`;
  await explain(put(key, metadata), `failed to upload ${key}`);
  return presign(key);
}

export async function pullFiles(
  mounts: Mount[],
  filesystem: SpriteFilesystem,
): Promise<void> {
  await Promise.all(
    mounts.map(async ([local, path]) => {
      const data = await explain(
        filesystem.readFile(path),
        `failed to pull ${path}`,
      );
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, data);
    }),
  );
}
