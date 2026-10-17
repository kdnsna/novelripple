import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  M1ReportRoutingError,
  redactM1BenchmarkId,
  resolveM1ReportRouting,
  type M1ReportStory,
} from "@/evals/m1-report-routing";

const repositoryRoot = "/repo";
const publicManifest = "/repo/benchmarks/m1/public/story-a/manifest.json";
const privateManifest = "/repo/benchmarks/private/story-a/manifest.json";
const outsideManifest = "/tmp/private-bench/story-a/manifest.json";

function story(overrides: Partial<M1ReportStory> = {}): M1ReportStory {
  return {
    storyClass: "A",
    benchmarkId: "m1-public-a",
    manifestPath: publicManifest,
    visibility: "public",
    ...overrides,
  };
}

describe("M1 report routing", () => {
  it("keeps public runs writing the dashboard into tracked docs/evals/runs", () => {
    expect(
      resolveM1ReportRouting({
        repositoryRoot,
        stories: [story()],
      }),
    ).toEqual({
      privateRun: false,
      privateStoryClasses: [],
      reportTarget: "docs-runs",
      redactPrivateBenchmarkIds: false,
    });
  });

  it("routes private visibility runs next to metrics.json and redacts IDs", () => {
    const routing = resolveM1ReportRouting({
      repositoryRoot,
      stories: [story({ visibility: "private" })],
    });

    expect(routing).toEqual({
      privateRun: true,
      privateStoryClasses: ["A"],
      reportTarget: "run-directory",
      redactPrivateBenchmarkIds: true,
    });
    expect(redactM1BenchmarkId("A")).toBe("private:A");
  });

  it("treats a manifest inside NOVELRIPPLE_BENCH_ROOT as private even if visibility is missing", () => {
    const routing = resolveM1ReportRouting({
      repositoryRoot,
      stories: [
        story({
          manifestPath: outsideManifest,
          visibility: undefined,
        }),
      ],
      extraPrivateRoot: "/tmp/private-bench",
    });

    expect(routing.privateRun).toBe(true);
    expect(routing.reportTarget).toBe("run-directory");
  });

  it("treats a manifest inside repository benchmarks/private as private", () => {
    const routing = resolveM1ReportRouting({
      repositoryRoot,
      stories: [story({ manifestPath: privateManifest, visibility: undefined })],
    });

    expect(routing.privateStoryClasses).toEqual(["A"]);
    expect(routing.reportTarget).toBe("run-directory");
  });

  it("rejects --report-dir under docs for a private run", () => {
    let error: unknown;
    try {
      resolveM1ReportRouting({
        repositoryRoot,
        stories: [story({ visibility: "private" })],
        reportDir: "/repo/docs/evals/local-run",
        reportDirProvided: true,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(M1ReportRoutingError);
    expect(error).toMatchObject({
      code: "report_dir_inside_repository_for_private_run",
    });
  });

  it("rejects any non-ignored in-repository --report-dir for a private run", () => {
    expect(() =>
      resolveM1ReportRouting({
        repositoryRoot,
        stories: [story({ visibility: "private" })],
        reportDir: "/repo/src/eval-runs",
        reportDirProvided: true,
        isGitIgnored: () => false,
      }),
    ).toThrow(M1ReportRoutingError);
  });

  it("allows an in-repository --report-dir only when git ignores it", () => {
    const checked: string[] = [];
    const routing = resolveM1ReportRouting({
      repositoryRoot,
      stories: [story({ visibility: "private" })],
      reportDir: "/repo/.data/evals/custom",
      reportDirProvided: true,
      isGitIgnored: (candidate) => {
        checked.push(candidate);
        return true;
      },
    });

    expect(routing.reportTarget).toBe("run-directory");
    expect(checked).toEqual(["/repo/.data/evals/custom"]);
  });

  it("allows --report-dir outside the repository for a private run", () => {
    expect(
      resolveM1ReportRouting({
        repositoryRoot,
        stories: [story({ visibility: "private" })],
        reportDir: "/tmp/m1-private-report",
        reportDirProvided: true,
      }).reportTarget,
    ).toBe("run-directory");
  });

  it("keeps the run directory when --report-dir is given for a public run", () => {
    expect(
      resolveM1ReportRouting({
        repositoryRoot,
        stories: [story()],
        reportDir: "/repo/.data/evals/custom",
        reportDirProvided: true,
      }).reportTarget,
    ).toBe("run-directory");
  });

  it("realpaths a symlink from an ignored directory into a tracked directory before checking", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "m1-report-routing-"));
    try {
      const repo = path.join(temp, "repo");
      const tracked = path.join(repo, "docs");
      const ignored = path.join(repo, ".data", "evals");
      await mkdir(tracked, { recursive: true });
      await mkdir(ignored, { recursive: true });
      await symlink(tracked, path.join(ignored, "escape"), "dir");
      const checked: string[] = [];

      expect(() =>
        resolveM1ReportRouting({
          repositoryRoot: realpathSync(repo),
          stories: [story({ visibility: "private" })],
          reportDir: path.join(ignored, "escape", "run"),
          reportDirProvided: true,
          isGitIgnored: (candidate) => {
            checked.push(candidate);
            return candidate.startsWith(ignored);
          },
          realpath: (candidate) => realpathSync(candidate),
        }),
      ).toThrow(M1ReportRoutingError);
      // 检查看到的是真实目标 docs/run，而不是被忽略目录里的链接路径。
      expect(checked).toEqual([path.join(realpathSync(tracked), "run")]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("realpaths the repository root too, so a symlinked root cannot hide an in-repo report dir", async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), "m1-report-routing-"));
    try {
      const repo = path.join(temp, "repo");
      const tracked = path.join(repo, "docs");
      await mkdir(tracked, { recursive: true });
      const repoLink = path.join(temp, "repo-link");
      await symlink(repo, repoLink, "dir");

      expect(() =>
        resolveM1ReportRouting({
          repositoryRoot: repoLink,
          stories: [story({ visibility: "private" })],
          reportDir: path.join(realpathSync(tracked), "run"),
          reportDirProvided: true,
          isGitIgnored: () => false,
          realpath: (candidate) => realpathSync(candidate),
        }),
      ).toThrow(M1ReportRoutingError);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
