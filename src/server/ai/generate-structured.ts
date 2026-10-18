import { createHash } from "node:crypto";

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "openai";
import { z } from "zod";

import {
  createGenerationRun,
  failGenerationRun,
  incrementGenerationRunModelCalls,
  succeedGenerationRun,
} from "@/server/repositories/generation-run-repository";

import {
  INITIAL_RETRY_POLICY,
  REPAIR_RETRY_POLICY,
  type RetryPolicy,
} from "./structured-retry-policy";
import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
  StructuredGenerationInput,
  StructuredGenerationResult,
  StructuredValidationIssue,
} from "./types";

const InputMetadataSchema = z
  .object({
    projectId: z.string().min(1),
    worldlineId: z.string().min(1).nullable().optional(),
    storyMapArtifactId: z.string().min(1).nullable().optional(),
    kind: z.string().min(1),
    promptVersion: z.string().min(1),
    prompt: z.string().min(1),
    schemaName: z
      .string()
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    modelConfig: z
      .object({
        model: z.string().min(1),
        structuredOutputMode: z.enum([
          "json_schema",
          "json_object",
          "prompt_json",
        ]),
        maxTokens: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

type Attempt = {
  kind: "initial" | "repair";
  rawOutput: string;
};

type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; issues: string[] };

export class StructuredGenerationError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super("Structured generation failed schema validation");
    this.name = "StructuredGenerationError";
    this.runId = runId;
  }
}

export async function generateStructured<T>(
  input: StructuredGenerationInput<T>,
  provider: AIProvider,
): Promise<StructuredGenerationResult<T>> {
  const metadata = InputMetadataSchema.parse({
    projectId: input.projectId,
    worldlineId: input.worldlineId,
    storyMapArtifactId: input.storyMapArtifactId,
    kind: input.kind,
    promptVersion: input.promptVersion,
    prompt: input.prompt,
    schemaName: input.schemaName,
    modelConfig: input.modelConfig,
  });
  const providerName = z.string().min(1).parse(provider.providerName);
  const jsonSchema = z.toJSONSchema(input.schema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        prompt: metadata.prompt,
        promptVersion: metadata.promptVersion,
        schemaName: metadata.schemaName,
        jsonSchema,
        modelConfig: metadata.modelConfig,
      }),
      "utf8",
    )
    .digest("hex");
  const run = createGenerationRun({
    projectId: metadata.projectId,
    worldlineId: metadata.worldlineId ?? null,
    storyMapArtifactId: metadata.storyMapArtifactId ?? null,
    kind: metadata.kind,
    provider: providerName,
    model: metadata.modelConfig.model,
    promptVersion: metadata.promptVersion,
    inputHash,
  });
  const attempts: Attempt[] = [];
  const callProvider = (request: AIProviderRequest): Promise<AIProviderResponse> => {
    // 先让调用方做预算判断；若它抛错，本次 provider 调用不会发生。
    input.onAttempt?.();
    // 每次真实调用（含 repair 与瞬时网络重试）前落库；写入失败时这里抛错，
    // provider.generate 不会执行，避免产生未计入预算的调用。
    incrementGenerationRunModelCalls(run.id);
    return provider.generate({
      ...request,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };

  let initialResponse: AIProviderResponse;
  try {
    initialResponse = await callWithRetries(
      callProvider,
      {
        prompt: metadata.prompt,
        schemaName: metadata.schemaName,
        jsonSchema,
        modelConfig: metadata.modelConfig,
      },
      INITIAL_RETRY_POLICY,
      input.signal,
      input.sleep ?? defaultSleep,
    );
  } catch (error) {
    failGenerationRun({
      id: run.id,
      rawOutput: null,
      error: errorMessage(error),
    });
    throw error;
  }

  attempts.push({ kind: "initial", rawOutput: initialResponse.rawOutput });
  let initialValidation: ValidationResult<T>;
  try {
    initialValidation = validateRawOutput(
      initialResponse.rawOutput,
      input.schema,
      input.validate,
    );
  } catch (error) {
    failGenerationRun({
      id: run.id,
      rawOutput: serializeAttempts(attempts),
      error: errorMessage(error),
    });
    throw error;
  }
  if (initialValidation.success) {
    succeedGenerationRun({ id: run.id, rawOutput: serializeAttempts(attempts) });
    return buildResult(
      initialValidation.value,
      run.id,
      providerName,
      metadata.modelConfig.model,
      1,
      initialResponse,
    );
  }

  let repairResponse: AIProviderResponse;
  // 首轮不合法时若调用方已中止（例如分块并发第一处失败），不再发 repair 请求。
  if (input.signal?.aborted) {
    const reason = abortReason(input.signal);
    failGenerationRun({
      id: run.id,
      rawOutput: serializeAttempts(attempts),
      error: errorMessage(reason),
    });
    throw reason;
  }
  try {
    repairResponse = await callWithRetries(
      callProvider,
      {
        prompt: metadata.prompt,
        schemaName: metadata.schemaName,
        jsonSchema,
        modelConfig: metadata.modelConfig,
        repair: {
          previousRawOutput: initialResponse.rawOutput,
          validationIssues: initialValidation.issues,
        },
      },
      REPAIR_RETRY_POLICY,
      input.signal,
      input.sleep ?? defaultSleep,
    );
  } catch (error) {
    failGenerationRun({
      id: run.id,
      rawOutput: serializeAttempts(attempts),
      error: errorMessage(error),
    });
    throw error;
  }

  attempts.push({ kind: "repair", rawOutput: repairResponse.rawOutput });
  let repairValidation: ValidationResult<T>;
  try {
    repairValidation = validateRawOutput(
      repairResponse.rawOutput,
      input.schema,
      input.validate,
    );
  } catch (error) {
    failGenerationRun({
      id: run.id,
      rawOutput: serializeAttempts(attempts),
      error: errorMessage(error),
    });
    throw error;
  }
  if (repairValidation.success) {
    succeedGenerationRun({ id: run.id, rawOutput: serializeAttempts(attempts) });
    return buildResult(
      repairValidation.value,
      run.id,
      providerName,
      metadata.modelConfig.model,
      2,
      repairResponse,
    );
  }

  failGenerationRun({
    id: run.id,
    rawOutput: serializeAttempts(attempts),
    error: repairValidation.issues.join("; "),
  });
  throw new StructuredGenerationError(run.id);
}

function validateRawOutput<T>(
  rawOutput: string,
  schema: z.ZodType<T>,
  validate?: (value: T) => StructuredValidationIssue[],
): ValidationResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return { success: false, issues: ["Response is not valid JSON"] };
  }

  const validation = schema.safeParse(parsed);
  if (!validation.success) {
    return {
      success: false,
      issues: validation.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "$";
        return `${path}: ${issue.message}`;
      }),
    };
  }

  const deterministicIssues = validate?.(validation.data) ?? [];
  if (deterministicIssues.length > 0) {
    return {
      success: false,
      issues: deterministicIssues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path : "$";
        return `${path}: ${issue.message}`;
      }),
    };
  }

  return { success: true, value: validation.data };
}

function serializeAttempts(attempts: Attempt[]): string {
  return JSON.stringify({ attempts });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provider error";
  return message.slice(0, 2_000);
}

/** 抛出调用方给的 abort reason；没有 reason 时给一个明确错误。 */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Structured generation aborted");
}

/** 瞬时网络错误重试前的随机退避区间（毫秒）。 */
const TRANSIENT_RETRY_MIN_DELAY_MS = 500;
const TRANSIENT_RETRY_MAX_DELAY_MS = 1_500;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function transientRetryDelay(): number {
  return (
    TRANSIENT_RETRY_MIN_DELAY_MS +
    Math.floor(
      Math.random() *
        (TRANSIENT_RETRY_MAX_DELAY_MS - TRANSIENT_RETRY_MIN_DELAY_MS + 1),
    )
  );
}

/**
 * 统一的重试入口：每次真实调用都经过 callProvider，因此 onAttempt
 * （Story Map 的模型调用预算）能看到包括重试在内的每一次尝试。
 * 瞬时网络错误在重试前等待 500–1500ms 随机退避；等待期间中止则抛出
 * 调用方的 abort reason。
 */
async function callWithRetries(
  callProvider: (request: AIProviderRequest) => Promise<AIProviderResponse>,
  request: AIProviderRequest,
  policy: RetryPolicy,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<AIProviderResponse> {
  let emptyResponseRetries = 0;
  let transientNetworkRetries = 0;

  for (;;) {
    try {
      return await callProvider(request);
    } catch (error) {
      const transient = isTransientNetworkError(error);
      if (transient) {
        if (transientNetworkRetries >= policy.transientNetworkRetries) throw error;
        transientNetworkRetries += 1;
      } else if (isEmptyResponseError(error)) {
        if (emptyResponseRetries >= policy.emptyResponseRetries) throw error;
        emptyResponseRetries += 1;
      } else {
        throw error;
      }

      // 调用方已中止时不再重试，直接抛出其 abort reason。
      if (signal?.aborted) throw abortReason(signal);
      if (transient) {
        await sleep(transientRetryDelay());
        if (signal?.aborted) throw abortReason(signal);
      }
    }
  }
}

const TRANSIENT_NETWORK_PATTERN =
  /terminated|fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|socket hang up/i;

const ABORT_ERROR_NAMES = new Set(["aborterror", "apiuseraborterror"]);
const VALIDATION_ERROR_NAMES = new Set([
  "zoderror",
  "structuredgenerationerror",
  "validationerror",
]);

/**
 * 瞬时网络错误：OpenAI SDK 的连接/超时错误，或错误链中匹配
 * terminated / fetch failed / ECONNRESET / ETIMEDOUT / UND_ERR_SOCKET /
 * socket hang up 的错误。
 *
 * 中止、HTTP 4xx 与 Schema/领域校验错误永远不重试。
 */
export function isTransientNetworkError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let transient = false;

  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    const name =
      typeof record.name === "string" ? record.name.toLowerCase() : "";
    const code = typeof record.code === "string" ? record.code : "";
    const message =
      typeof record.message === "string" ? record.message : "";

    if (
      current instanceof APIUserAbortError ||
      ABORT_ERROR_NAMES.has(name) ||
      code.toLowerCase() === "abort_err" ||
      record.code === 20
    ) {
      return false;
    }
    const status =
      typeof record.status === "number"
        ? record.status
        : typeof record.statusCode === "number"
          ? record.statusCode
          : undefined;
    if (status !== undefined && status >= 400 && status < 500) return false;
    if (
      VALIDATION_ERROR_NAMES.has(name) ||
      message.toLowerCase().includes("schema validation") ||
      message.toLowerCase().includes("not valid json")
    ) {
      return false;
    }

    if (
      current instanceof APIConnectionError ||
      current instanceof APIConnectionTimeoutError ||
      name === "apiconnectionerror" ||
      name === "apiconnectiontimeouterror" ||
      TRANSIENT_NETWORK_PATTERN.test(code) ||
      TRANSIENT_NETWORK_PATTERN.test(message)
    ) {
      transient = true;
    }

    current = record.cause;
  }

  return transient;
}

/** 空响应错误：provider 返回了无文本内容的完成（模型瞬时故障，可安全重试）。 */
function isEmptyResponseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("no text content")
  );
}

function buildResult<T>(
  value: T,
  runId: string,
  provider: string,
  model: string,
  attemptCount: 1 | 2,
  response: AIProviderResponse,
): StructuredGenerationResult<T> {
  return {
    value,
    generation: {
      runId,
      provider,
      model,
      attemptCount,
      ...(response.requestId ? { requestId: response.requestId } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    },
  };
}
