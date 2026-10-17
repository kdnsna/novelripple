import { describe, expect, it } from "vitest";

import {
  M1BaselineArgumentError,
  parseM1BaselineArguments,
} from "@/evals/m1-baseline-arguments";

function parse(args: string[]) {
  return parseM1BaselineArguments(args);
}

function errorCode(callback: () => void): string | undefined {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error instanceof M1BaselineArgumentError ? error.code : "unknown";
  }
}

describe("M1 baseline arguments", () => {
  it("keeps the formal three-manifest requirement without --tuning", () => {
    expect(
      parse(["--manifest", "a.json", "--manifest", "b.json", "--manifest", "c.json"]),
    ).toEqual({
      manifestPaths: ["a.json", "b.json", "c.json"],
      tuning: false,
    });
    expect(errorCode(() => parse(["--manifest", "a.json"]))).toBe(
      "at_least_three_manifests_required",
    );
  });

  it("allows one or two manifests only in tuning mode", () => {
    expect(parse(["--tuning", "--manifest", "a.json"])).toEqual({
      manifestPaths: ["a.json"],
      tuning: true,
    });
    expect(
      parse(["--tuning", "--manifest", "a.json", "--manifest", "b.json"]),
    ).toEqual({
      manifestPaths: ["a.json", "b.json"],
      tuning: true,
    });
    expect(
      errorCode(() =>
        parse([
          "--tuning",
          "--manifest",
          "a.json",
          "--manifest",
          "b.json",
          "--manifest",
          "c.json",
        ]),
      ),
    ).toBe("tuning_requires_one_or_two_manifests");
  });

  it("rejects unknown arguments with a stable failure code", () => {
    expect(errorCode(() => parse(["--unknown"]))).toBe("invalid_arguments");
  });
});
