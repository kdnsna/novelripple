import type {
  AIProvider,
  AIProviderRequest,
  AIProviderResponse,
} from "./types";

type MockOutput = string | Error | AIProviderResponse;

export class MockAIProvider implements AIProvider {
  readonly providerName: string;
  readonly requests: AIProviderRequest[] = [];
  readonly #outputs: MockOutput[];

  constructor(outputs: MockOutput[], providerName = "mock") {
    this.#outputs = [...outputs];
    this.providerName = providerName;
  }

  async generate(request: AIProviderRequest): Promise<AIProviderResponse> {
    this.requests.push(request);
    const output = this.#outputs.shift();

    if (output === undefined) throw new Error("Mock AI output queue is empty");
    if (output instanceof Error) throw output;
    if (typeof output === "string") return { rawOutput: output };
    return output;
  }
}
