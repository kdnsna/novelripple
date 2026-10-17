import { describe, expect, it } from "vitest";

import {
  JOB_POLL_BASE_DELAY_MS,
  JOB_POLL_MAX_DELAY_MS,
  jobPollBackoffMs,
} from "@/components/project/job-poll-backoff";

describe("jobPollBackoffMs", () => {
  it("uses 1s after a success and doubles on consecutive failures", () => {
    expect(jobPollBackoffMs(0)).toBe(JOB_POLL_BASE_DELAY_MS);
    expect(jobPollBackoffMs(1)).toBe(1_000);
    expect(jobPollBackoffMs(2)).toBe(2_000);
    expect(jobPollBackoffMs(3)).toBe(4_000);
    expect(jobPollBackoffMs(4)).toBe(8_000);
    expect(jobPollBackoffMs(5)).toBe(16_000);
  });

  it("caps at 30s instead of growing forever", () => {
    expect(jobPollBackoffMs(6)).toBe(JOB_POLL_MAX_DELAY_MS);
    expect(jobPollBackoffMs(7)).toBe(JOB_POLL_MAX_DELAY_MS);
    expect(jobPollBackoffMs(100)).toBe(JOB_POLL_MAX_DELAY_MS);
  });

  it("rejects invalid failure counts", () => {
    expect(() => jobPollBackoffMs(-1)).toThrow();
    expect(() => jobPollBackoffMs(1.5)).toThrow();
    expect(() => jobPollBackoffMs(Number.NaN)).toThrow();
  });
});
