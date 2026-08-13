/**
 * OpenAI strict JSON Schema 适配。
 *
 * `z.toJSONSchema` 的 draft-7 输出与 OpenAI strict 模式不兼容：
 * optional 字段不进 required、nullable 字段展开为 anyOf（strict 禁止 anyOf）。
 * 本模块把领域 Schema 的 JSON Schema 表示转换为 strict 可接受的“线缆 Schema”，
 * 并对响应做反向归一化：nullable 字段的 "" 哨兵还原为 null。
 * 本地 Zod / 领域校验始终是权威；这里只调整线上表示，不改变领域合同。
 */

const EMPTY_NULLABLE_NOTE = "没有适用值时使用空字符串，服务端会将其还原为 null。";

export type StrictSchemaPreparation = {
  schema: Record<string, unknown>;
  nullablePaths: string[];
};

export function toOpenAIStrictSchema(
  schema: Record<string, unknown>,
): StrictSchemaPreparation {
  const nullablePaths: string[] = [];
  const strict = transform(schema, "$", nullablePaths) as Record<string, unknown>;
  return { schema: strict, nullablePaths };
}

export function normalizeStrictResponse(
  parsed: unknown,
  nullablePaths: string[],
): unknown {
  if (nullablePaths.length === 0) return parsed;
  const target = new Set(nullablePaths);
  const isNullablePath = (path: string): boolean =>
    target.has(path) || target.has(path.replace(/\[\d+\]/g, "[]"));

  const walk = (node: unknown, path: string): unknown => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${path}[${index}]`));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const childPath = `${path}.${key}`;
      out[key] =
        isNullablePath(childPath) && child === "" ? null : walk(child, childPath);
    }
    return out;
  };

  return walk(parsed, "$");
}

function transform(
  node: unknown,
  path: string,
  nullablePaths: string[],
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => transform(item, path, nullablePaths));
  }
  if (node === null || typeof node !== "object") return node;
  const value = node as Record<string, unknown>;

  if (value.type === "object") {
    const properties = (value.properties ?? {}) as Record<string, unknown>;
    return {
      ...value,
      additionalProperties: false,
      required: Object.keys(properties),
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [
          key,
          transform(child, `${path}.${key}`, nullablePaths),
        ]),
      ),
    };
  }

  if (Array.isArray(value.anyOf)) {
    const branches = value.anyOf as unknown[];
    const nonNull = branches.filter(
      (branch) => (branch as { type?: string } | null)?.type !== "null",
    );
    if (nonNull.length !== branches.length) {
      if (nonNull.length !== 1) {
        throw new Error(
          `json_schema 严格模式不支持的 anyOf 结构：${path}`,
        );
      }
      nullablePaths.push(path);
      const inner = transform(nonNull[0], path, nullablePaths) as Record<
        string,
        unknown
      >;
      const description =
        typeof inner.description === "string" && inner.description.length > 0
          ? `${inner.description} ${EMPTY_NULLABLE_NOTE}`
          : EMPTY_NULLABLE_NOTE;
      return { ...inner, description };
    }
    throw new Error(`json_schema 严格模式不支持的 anyOf 结构：${path}`);
  }

  const next: Record<string, unknown> = { ...value };
  if (next.items !== undefined) {
    next.items = transform(next.items, `${path}[]`, nullablePaths);
  }
  return next;
}
