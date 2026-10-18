import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import {
  WorldlineCharacterStatusOverrideSchema,
  type CharacterStatus,
  type WorldlineCharacterStatusOverride,
} from "@/domain/schemas";
import { getDatabase } from "@/server/db/client";
import { worldlineCharacterStatusOverrides } from "@/server/db/schema";
import { getContinuationArtifact } from "@/server/repositories/continuation-repository";
import { getWorldline } from "@/server/repositories/ripple-repository";
import { getStoryMapArtifact } from "@/server/repositories/story-map-artifact-repository";

export class CharacterStatusOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterStatusOverrideError";
  }
}

export function isCharacterStatusOverrideError(
  error: unknown,
): error is CharacterStatusOverrideError {
  return error instanceof CharacterStatusOverrideError;
}

export function listCharacterStatusOverrides(
  worldlineId: string,
): WorldlineCharacterStatusOverride[] {
  return getDatabase()
    .select()
    .from(worldlineCharacterStatusOverrides)
    .where(eq(worldlineCharacterStatusOverrides.worldlineId, worldlineId))
    .orderBy(
      asc(worldlineCharacterStatusOverrides.createdAt),
      asc(worldlineCharacterStatusOverrides.id),
    )
    .all()
    .map(parseOverride);
}

/**
 * 追加一条读者人物状态覆盖。
 *
 * - 只追加，不 UPDATE/DELETE；
 * - characterId 必须存在于该 Worldline 绑定的 Story Map；
 * - anchorSceneId 为 null（分歧点起）或本 Worldline 上真实存在的场景；
 * - 同一 (worldlineId, idempotencyKey) 幂等返回已有行。
 */
export function createCharacterStatusOverride(input: {
  projectId: string;
  worldlineId: string;
  anchorSceneId: string | null;
  characterId: string;
  status: CharacterStatus;
  idempotencyKey: string;
}): WorldlineCharacterStatusOverride {
  const worldline = getWorldline(input.worldlineId);
  if (!worldline || worldline.projectId !== input.projectId) {
    throw new CharacterStatusOverrideError("找不到属于当前项目的 Worldline。");
  }
  const storyMapArtifact = getStoryMapArtifact(
    worldline.baseStoryMapArtifactId,
  );
  if (
    !storyMapArtifact ||
    storyMapArtifact.projectId !== input.projectId ||
    storyMapArtifact.storyMap.status !== "confirmed"
  ) {
    throw new CharacterStatusOverrideError(
      "Worldline 未绑定 confirmed Story Map 基线。",
    );
  }
  if (
    !storyMapArtifact.storyMap.characters.some(
      (character) => character.id === input.characterId,
    )
  ) {
    throw new CharacterStatusOverrideError(
      "人物不在当前 Worldline 的 Story Map 中。",
    );
  }
  if (input.anchorSceneId !== null) {
    const anchor = getContinuationArtifact(input.anchorSceneId);
    if (
      !anchor ||
      anchor.artifactType !== "scene" ||
      anchor.projectId !== input.projectId ||
      anchor.worldlineId !== worldline.id
    ) {
      throw new CharacterStatusOverrideError(
        "状态覆盖的锚点必须是当前 Worldline 上已生成的场景。",
      );
    }
  }

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw new CharacterStatusOverrideError("状态覆盖缺少幂等键。");
  }
  const existing = getDatabase()
    .select()
    .from(worldlineCharacterStatusOverrides)
    .where(
      and(
        eq(worldlineCharacterStatusOverrides.worldlineId, worldline.id),
        eq(worldlineCharacterStatusOverrides.idempotencyKey, idempotencyKey),
      ),
    )
    .get();
  if (existing) return parseOverride(existing);

  const override = WorldlineCharacterStatusOverrideSchema.parse({
    id: `worldline_character_status_${randomUUID()}`,
    worldlineId: worldline.id,
    anchorSceneId: input.anchorSceneId,
    characterId: input.characterId,
    status: input.status,
    idempotencyKey,
    createdAt: new Date().toISOString(),
  });

  getDatabase()
    .insert(worldlineCharacterStatusOverrides)
    .values({
      id: override.id,
      worldlineId: override.worldlineId,
      anchorSceneId: override.anchorSceneId,
      characterId: override.characterId,
      status: override.status,
      idempotencyKey: override.idempotencyKey,
      createdAt: override.createdAt,
    })
    .run();

  const stored = getDatabase()
    .select()
    .from(worldlineCharacterStatusOverrides)
    .where(eq(worldlineCharacterStatusOverrides.id, override.id))
    .get();
  if (!stored) throw new CharacterStatusOverrideError("人物状态覆盖写入失败。");
  return parseOverride(stored);
}

function parseOverride(
  row: typeof worldlineCharacterStatusOverrides.$inferSelect,
): WorldlineCharacterStatusOverride {
  return WorldlineCharacterStatusOverrideSchema.parse({
    id: row.id,
    worldlineId: row.worldlineId,
    anchorSceneId: row.anchorSceneId ?? null,
    characterId: row.characterId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    createdAt: normalizeSqliteDate(row.createdAt),
  });
}

function normalizeSqliteDate(value: string): string {
  if (value.includes("T")) return value;
  return `${value.replace(" ", "T")}Z`;
}
