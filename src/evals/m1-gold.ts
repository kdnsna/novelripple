import { z } from "zod";

/**
 * Private M1 gold 格式。只用于评测，不进入 Story Map 生产管线。
 * 条目内额外的标注字段（note、firstMention、descriptive 等）会被忽略。
 * `unit` 是 `deriveEvidenceUnits(source)` 的 1-based 下标；`unitId` 是可读的稳定 Unit 标识。
 */
const GoldEvidenceSchema = z
  .object({
    unit: z.number().int().positive(),
    unitId: z.string().regex(/^u\d{6}$/),
    section: z.number().int().positive(),
    quote: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strip()
  .refine((evidence) => evidence.start < evidence.end, {
    message: "gold evidence 必须是非空范围",
    path: ["end"],
  })
  .refine(
    (evidence) =>
      evidence.unitId === `u${String(evidence.unit).padStart(6, "0")}`,
    {
      message: "gold evidence unitId 必须与 unit 对应",
      path: ["unitId"],
    },
  );

const GoldCharacterSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    tier: z.enum(["core", "supporting"]),
    evidence: z.array(GoldEvidenceSchema).min(1),
  })
  .strip();

const GoldMentionedOnlySchema = z
  .object({
    name: z.string().min(1),
    evidence: z.array(GoldEvidenceSchema).min(1),
  })
  .strip();

const GoldEventSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    storyOrder: z.number().int().positive(),
    narrativeMode: z.string().min(1),
    characterIds: z.array(z.string().min(1)),
    narrativeFirstUnit: z.number().int().positive(),
    evidence: z.array(GoldEvidenceSchema).min(1),
  })
  .strip();

const GoldCausalLinkSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    strength: z.enum(["hard", "soft"]),
    label: z.string().min(1),
    evidence: z.array(GoldEvidenceSchema).min(1),
  })
  .strip();

const GoldEndingSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    interpretive: z.boolean(),
    characterIds: z.array(z.string().min(1)),
    evidence: z.array(GoldEvidenceSchema).min(1),
  })
  .strip();

export const M1GoldSchema = z
  .object({
    schemaVersion: z.literal(1),
    storyId: z.string().min(1),
    characters: z.array(GoldCharacterSchema),
    mentionedOnly: z.array(GoldMentionedOnlySchema),
    events: z.array(GoldEventSchema),
    causalLinks: z.array(GoldCausalLinkSchema),
    endings: z.array(GoldEndingSchema),
  })
  .passthrough()
  .superRefine((gold, context) => {
    const characterIds = new Set<string>();
    gold.characters.forEach((character, index) => {
      if (characterIds.has(character.id)) {
        context.addIssue({
          code: "custom",
          path: ["characters", index, "id"],
          message: "gold character ID 不得重复",
        });
      }
      characterIds.add(character.id);
    });

    const eventIds = new Set<string>();
    gold.events.forEach((event, index) => {
      if (eventIds.has(event.id)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "id"],
          message: "gold event ID 不得重复",
        });
      }
      eventIds.add(event.id);
      for (const characterId of event.characterIds) {
        if (!characterIds.has(characterId)) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "characterIds"],
            message: `gold event 引用了未知 character ${characterId}`,
          });
        }
      }
    });

    const linkIds = new Set<string>();
    gold.causalLinks.forEach((link, index) => {
      if (linkIds.has(link.id)) {
        context.addIssue({
          code: "custom",
          path: ["causalLinks", index, "id"],
          message: "gold causal link ID 不得重复",
        });
      }
      linkIds.add(link.id);
      for (const endpoint of ["from", "to"] as const) {
        if (!eventIds.has(link[endpoint])) {
          context.addIssue({
            code: "custom",
            path: ["causalLinks", index, endpoint],
            message: `gold causal link 引用了未知 event ${link[endpoint]}`,
          });
        }
      }
    });

    const endingIds = new Set<string>();
    gold.endings.forEach((ending, index) => {
      if (endingIds.has(ending.id)) {
        context.addIssue({
          code: "custom",
          path: ["endings", index, "id"],
          message: "gold ending ID 不得重复",
        });
      }
      endingIds.add(ending.id);
      for (const characterId of ending.characterIds) {
        if (!characterIds.has(characterId)) {
          context.addIssue({
            code: "custom",
            path: ["endings", index, "characterIds"],
            message: `gold ending 引用了未知 character ${characterId}`,
          });
        }
      }
    });
  });

export type M1Gold = z.infer<typeof M1GoldSchema>;
export type M1GoldCharacter = z.infer<typeof GoldCharacterSchema>;
export type M1GoldEvidence = z.infer<typeof GoldEvidenceSchema>;

export function parseM1Gold(value: unknown): M1Gold {
  return M1GoldSchema.parse(value);
}
