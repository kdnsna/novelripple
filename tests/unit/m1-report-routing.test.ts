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
      code: "report_dir_inside_docs_for_private_run",
    });
  });

  it("allows --report-dir outside docs for a private run", () => {
    expect(
      resolveM1ReportRouting({
        repositoryRoot,
        stories: [story({ visibility: "private" })],
        reportDir: "/repo/.data/evals/custom",
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
});
