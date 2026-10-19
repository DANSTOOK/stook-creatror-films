/**
 * Just enough of the OpenType format to check a bundled font in a unit test:
 * which characters its cmap maps to a glyph, and the weight range its fvar
 * table offers. Only uncompressed TrueType/OpenType files (.ttf/.otf) are
 * read; the WOFF2 files are left to their own hash checks.
 */

interface Table {
  offset: number;
  length: number;
}

function tables(data: Buffer): Map<string, Table> {
  const count = data.readUInt16BE(4);
  const found = new Map<string, Table>();
  for (let i = 0; i < count; i += 1) {
    const at = 12 + i * 16;
    found.set(data.toString('latin1', at, at + 4), { offset: data.readUInt32BE(at + 8), length: data.readUInt32BE(at + 12) });
  }
  return found;
}

/** Whether `code` has a glyph in a format 4 subtable starting at `at`. */
function inFormat4(data: Buffer, at: number, code: number): boolean {
  if (code > 0xffff) return false;
  const segments = data.readUInt16BE(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  for (let i = 0; i < segments; i += 1) {
    const end = data.readUInt16BE(ends + i * 2);
    if (code > end) continue;
    const start = data.readUInt16BE(starts + i * 2);
    if (code < start) return false;
    const delta = data.readInt16BE(deltas + i * 2);
    const rangeOffset = data.readUInt16BE(ranges + i * 2);
    if (rangeOffset === 0) return ((code + delta) & 0xffff) !== 0;
    const glyphAt = ranges + i * 2 + rangeOffset + (code - start) * 2;
    const glyph = data.readUInt16BE(glyphAt);
    return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
  }
  return false;
}

/** Whether `code` has a glyph in a format 12 subtable starting at `at`. */
function inFormat12(data: Buffer, at: number, code: number): boolean {
  const groups = data.readUInt32BE(at + 12);
  for (let i = 0; i < groups; i += 1) {
    const group = at + 16 + i * 12;
    const start = data.readUInt32BE(group);
    const end = data.readUInt32BE(group + 4);
    if (code >= start && code <= end) return data.readUInt32BE(group + 8) + (code - start) !== 0;
  }
  return false;
}

/** The characters of `text` the font has no glyph for. */
export function missingCharacters(data: Buffer, text: string): string[] {
  const cmap = tables(data).get('cmap');
  if (!cmap) return [...text];
  const count = data.readUInt16BE(cmap.offset + 2);
  // The Unicode subtables: Windows Unicode BMP or full repertoire, or the Unicode platform.
  const subtables: Array<{ at: number; format: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const record = cmap.offset + 4 + i * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    const at = cmap.offset + data.readUInt32BE(record + 4);
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))) subtables.push({ at, format: data.readUInt16BE(at) });
  }
  const has = (code: number): boolean =>
    subtables.some(({ at, format }) => (format === 4 ? inFormat4(data, at, code) : format === 12 ? inFormat12(data, at, code) : false));
  return [...new Set(text)].filter((character) => !has(character.codePointAt(0) ?? 0));
}

/** The weight range of a variable font's wght axis, or null for a static font. */
export function weightAxis(data: Buffer): { min: number; max: number } | null {
  const fvar = tables(data).get('fvar');
  if (!fvar) return null;
  const axesAt = fvar.offset + data.readUInt16BE(fvar.offset + 4);
  const axisCount = data.readUInt16BE(fvar.offset + 8);
  const axisSize = data.readUInt16BE(fvar.offset + 10);
  for (let i = 0; i < axisCount; i += 1) {
    const axis = axesAt + i * axisSize;
    if (data.toString('latin1', axis, axis + 4) !== 'wght') continue;
    return { min: data.readInt32BE(axis + 4) / 65536, max: data.readInt32BE(axis + 12) / 65536 };
  }
  return null;
}
