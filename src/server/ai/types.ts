import type { z } from "zod";

export type StructuredOutputMode =
  | "json_schema"
  | "json_object"
  | "prompt_json";

export type ModelConfig = {
  model: string;
  structuredOutputMode: StructuredOutputMode;
  /** 输出 token 上限（可选）。推理模型思考 token 计入输出预算，不设置时
   *  按服务商默认（DeepSeek 4096），长文生成（如 1200+ 字场景）可能被截断成空响应。 */
  maxTokens?: number;
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
  /** 可选：调用方中止在途请求（例如分块并发第一处失败后停止其余块）。 */
  signal?: AbortSignal;
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
  /** 可选：绑定本次生成到具体 Story Map revision，供按 revision 统计尝试。 */
  storyMapArtifactId?: string | null;
  kind: string;
  promptVersion: string;
  prompt: string;
  schemaName: string;
  schema: z.ZodType<T>;
  modelConfig: ModelConfig;
  validate?: (value: T) => StructuredValidationIssue[];
  /** 可选中止信号，透传给 provider。 */
  signal?: AbortSignal;
  /** 每次真正发起 provider 调用前触发（含 repair 与瞬时网络重试），在调用计数落库前执行。 */
  onAttempt?: () => void;
  /** 瞬时网络错误重试前的等待函数；测试可注入以跳过真实定时器。 */
  sleep?: (milliseconds: number) => Promise<void>;
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
