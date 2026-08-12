import type { z } from "zod";

export type StructuredOutputMode =
  | "json_schema"
  | "json_object"
  | "prompt_json";

export type ModelConfig = {
  model: string;
  structuredOutputMode: StructuredOutputMode;
};

export type GenerationUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type AIProviderRequest = {
  prompt: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  modelConfig: ModelConfig;
  repair?: {
    previousRawOutput: string;
    validationIssues: string[];
  };
};

export type AIProviderResponse = {
  rawOutput: string;
  requestId?: string;
  usage?: GenerationUsage;
};

export interface AIProvider {
  readonly providerName: string;
  generate(request: AIProviderRequest): Promise<AIProviderResponse>;
}

export type StructuredValidationIssue = {
  path: string;
  message: string;
};

export type StructuredGenerationInput<T> = {
  projectId: string;
  worldlineId?: string | null;
  kind: string;
  promptVersion: string;
  prompt: string;
  schemaName: string;
  schema: z.ZodType<T>;
  modelConfig: ModelConfig;
  validate?: (value: T) => StructuredValidationIssue[];
};

export type StructuredGenerationResult<T> = {
  value: T;
  generation: {
    runId: string;
    provider: string;
    model: string;
    attemptCount: 1 | 2;
    requestId?: string;
    usage?: GenerationUsage;
  };
};
