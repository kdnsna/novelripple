import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BenchmarkRootError,
  isPathInside,
  resolveBenchmarkRoot,
  selectBenchmarkRoot,
} from "@/evals/benchmark-root";

let temporaryDirectory: string;
let publicRoot: string;
let privateRoot: string;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "novelripple-benchmark-root-"),
  );
  publicRoot = path.join(temporaryDirectory, "benchmarks", "m1", "public");
  privateRoot = path.join(temporaryDirectory, "benchmarks", "private");
  await mkdir(publicRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
});

afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function createStory(root: string, id: string) {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, "manifest.json");
  const sourcePath = path.join(directory, "source.txt");
  await writeFile(
    manifestPath,
    JSON.stringify({ id, sourcePath: "source.txt" }),
    "utf8",
  );
  await writeFile(sourcePath, "短篇合成文本，仅用于单元测试。", "utf8");
  return {
    directory,
    manifestPath: await realpath(manifestPath),
    sourcePath: await realpath(sourcePath),
  };
}

describe("M1 benchmark root selection", () => {
  it("selects the public root only for a canonical public manifest path", async () => {
    const story = await createStory(publicRoot, "m1-public-a");

    await expect(
      resolveBenchmarkRoot({
        manifestPath: story.manifestPath,
        publicRoot,
        privateRoot,
      }),
    ).resolves.toEqual({
      root: await realpath(publicRoot),
      visibility: "public",
    });
  });

  it("accepts a missing repository private root and selects an extra private root", async () => {
    await rm(privateRoot, { recursive: true, force: true });
    const extraRoot = path.join(temporaryDirectory, "external-private");
    const story = await createStory(extraRoot, "m1-private-a");

    await expect(
      resolveBenchmarkRoot({
        manifestPath: story.manifestPath,
        publicRoot,
        privateRoot,
        extraPrivateRoot: extraRoot,
      }),
    ).resolves.toEqual({
      root: await realpath(extraRoot),
      visibility: "private",
    });
  });

  it("uses the realpath of an extra private root", async () => {
    const actualRoot = path.join(temporaryDirectory, "external-private-actual");
    const linkedRoot = path.join(temporaryDirectory, "external-private-link");
    await mkdir(actualRoot, { recursive: true });
    await symlink(actualRoot, linkedRoot, "dir");
    const story = await createStory(actualRoot, "m1-private-b");

    await expect(
      resolveBenchmarkRoot({
        manifestPath: story.manifestPath,
        publicRoot,
        privateRoot,
        extraPrivateRoot: linkedRoot,
      }),
    ).resolves.toEqual({
      root: await realpath(actualRoot),
      visibility: "private",
    });
  });

  it("treats a blank extra private root as unset", async () => {
    const story = await createStory(privateRoot, "m1-private-c");

    await expect(
      resolveBenchmarkRoot({
        manifestPath: story.manifestPath,
        publicRoot,
        privateRoot,
        extraPrivateRoot: "   ",
      }),
    ).resolves.toEqual({
      root: await realpath(privateRoot),
      visibility: "private",
    });
  });

  it("fails clearly before use when the extra private root does not exist", async () => {
    const story = await createStory(privateRoot, "m1-private-d");

    await expect(
      resolveBenchmarkRoot({
        manifestPath: story.manifestPath,
        publicRoot,
        privateRoot,
        extraPrivateRoot: path.join(temporaryDirectory, "missing-private"),
      }),
    ).rejects.toMatchObject({
      name: "BenchmarkRootError",
      code: "benchmark_root_not_found",
    });
  });

  it("fails clearly when the extra private root is not a directory", async () => {
    const rootFile = path.join(temporaryDirectory, "private-root.txt");
    await writeFile(rootFile, "不是目录。", "utf8");
    const story = await createStory(privateRoot, "m1-private-e");

    const error = await resolveBenchmarkRoot({
      manifestPath: story.manifestPath,
      publicRoot,
      privateRoot,
      extraPrivateRoot: rootFile,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BenchmarkRootError);
    expect(error).toMatchObject({ code: "benchmark_root_not_directory" });
  });

  it("returns null for a manifest outside every configured root", async () => {
    const story = await createStory(
      path.join(temporaryDirectory, "outside"),
      "m1-outside",
    );

    await expect(
      resolveBenchmarkRoot({
        manifestPath: story.manifestPath,
        publicRoot,
        privateRoot,
      }),
    ).resolves.toBeNull();
  });

  it("selects the public root before overlapping private roots", () => {
    expect(
      selectBenchmarkRoot({
        manifestPath: path.join(publicRoot, "m1-public-b", "manifest.json"),
        publicRoot,
        privateRoot,
        extraPrivateRoot: publicRoot,
      }),
    ).toEqual({ root: publicRoot, visibility: "public" });
  });

  it("keeps a source path inside the selected root and rejects siblings", async () => {
    const extraRoot = path.join(temporaryDirectory, "external-private");
    const story = await createStory(extraRoot, "m1-private-f");
    const outsideSource = path.join(temporaryDirectory, "outside-source.txt");
    await writeFile(outsideSource, "根目录外的合成文本。", "utf8");

    expect(isPathInside(extraRoot, story.sourcePath)).toBe(true);
    expect(isPathInside(extraRoot, outsideSource)).toBe(false);
  });

  it("does not treat a path with the same prefix as inside the root", () => {
    const root = path.join(temporaryDirectory, "root");

    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, path.join(root, "child"))).toBe(true);
    expect(isPathInside(root, `${root}-other`)).toBe(false);
    expect(isPathInside(root, temporaryDirectory)).toBe(false);
  });
});
