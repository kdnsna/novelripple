import type { Source } from "@/domain/schemas";

export type EvidenceUnit = {
  id: string;
  sourceId: string;
  sectionId: string;
  start: number;
  end: number;
  text: string;
};

export function deriveEvidenceUnits(source: Source): EvidenceUnit[] {
  const units: EvidenceUnit[] = [];
  const sections = [...source.sections].sort(
    (left, right) => left.start - right.start,
  );

  for (const section of sections) {
    const sectionText = source.normalizedText.slice(section.start, section.end);
    const boundaries = [...sectionText.matchAll(/\n[ \t]*\n+/g)];
    let blockStart = 0;

    for (const boundary of [...boundaries, undefined]) {
      const blockEnd = boundary?.index ?? sectionText.length;
      const block = sectionText.slice(blockStart, blockEnd);
      const firstContentOffset = block.search(/\S/u);

      if (firstContentOffset >= 0) {
        const trailingWhitespaceLength = block.match(/\s*$/u)?.[0].length ?? 0;
        const start = section.start + blockStart + firstContentOffset;
        const end = section.start + blockEnd - trailingWhitespaceLength;
        units.push({
          id: `evidence_unit:${source.id}:${String(units.length + 1).padStart(6, "0")}`,
          sourceId: source.id,
          sectionId: section.id,
          start,
          end,
          text: source.normalizedText.slice(start, end),
        });
      }

      if (boundary) blockStart = boundary.index + boundary[0].length;
    }
  }

  return units;
}
