import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createGenerationRun,
  failGenerationRun,
  succeedGenerationRun,
} from "@/server/repositories/generation-run-repository";

import type {
  AIProvider,
  AIProviderResponse,
  StructuredGenerationInput,
  StructuredGenerationResult,
  StructuredValidationIssue,
} from "./types";

const InputMetadataSchema = z
  .object({
    projectId: z.string().min(1),
    worldlineId: z.string().min(1).nullable().optional(),
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
    kind: metadata.kind,
    provider: providerName,
    model: metadata.modelConfig.model,
    promptVersion: metadata.promptVersion,
    inputHash,
  });
  const attempts: Attempt[] = [];

  let initialResponse: AIProviderResponse;
  try {
    initialResponse = await provider.generate({
      prompt: metadata.prompt,
      schemaName: metadata.schemaName,
      jsonSchema,
      modelConfig: metadata.modelConfig,
    });
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
  try {
    repairResponse = await provider.generate({
      prompt: metadata.prompt,
      schemaName: metadata.schemaName,
      jsonSchema,
      modelConfig: metadata.modelConfig,
      repair: {
        previousRawOutput: initialResponse.rawOutput,
        validationIssues: initialValidation.issues,
      },
    });
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
