/**
 * Generates assets/banner.svg and assets/mark.svg.
 *
 * The wordmark here is the same letterform grid the terminal splash draws with
 * half blocks, so the README and the program are showing the same shapes rather
 * than two designs that happen to share a name. Run `node tools/logo.mjs` after
 * changing either one.
 *
 * Letters are emitted as merged horizontal runs rather than one rect per cell,
 * which keeps the file small and makes the strokes look drawn instead of
 * pixelated at large sizes. No embedded fonts and no external references: the
 * only text in the output is the tagline, and it is pinned with textLength so a
 * viewer substituting a wider monospace font cannot push it past the edge.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 7 rows by 5 columns per letter. Same skeleton as the half-block wordmark. */
const GLYPHS = {
  R: ['####.', '#...#', '#...#', '####.', '#.##.', '#..##', '#...#'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
};

const WORD = 'RECUSE';
const CELL = 12;
/** One blank column between letters. */
const TRACK = 1;

/** Merge each row's filled cells into runs, so a bar is one rect not five. */
function letterRects(rows, originX, originY) {
  const out = [];

  rows.forEach((row, y) => {
    let run = 0;
    for (let x = 0; x <= row.length; x++) {
      if (row[x] === '#') {
        run += 1;
        continue;
      }
      if (run > 0) {
        out.push({
          x: originX + (x - run) * CELL,
          y: originY + y * CELL,
          w: run * CELL,
          // Three quarters of a pixel taller than the cell, so stacked rows
          // overlap instead of meeting exactly. Rects that share an edge get
          // antialiased on both sides of it and the seam shows as a hairline
          // through the middle of every vertical stroke.
          h: CELL + 0.75,
        });
        run = 0;
      }
    }
  });

  return out;
}

function wordmark(originX, originY) {
  const rects = [];
  let cursor = originX;

  for (const ch of WORD) {
    const glyph = GLYPHS[ch];
    rects.push(...letterRects(glyph, cursor, originY));
    cursor += (glyph[0].length + TRACK) * CELL;
  }

  return { rects, width: cursor - originX - TRACK * CELL };
}

const PALETTE = {
  ink: '#08080a',
  panel: '#0e0e11',
  accent: '#e8e6e3',
  dim: '#6f6a65',
  ramp: ['#6f6a65', '#d9a441', '#e0533d'],
};

/**
 * The mark: two overlapping circles with the lens filled.
 *
 * It is the product, not a decoration. One circle is everyone who decides a
 * market, the other is everyone who owns it, and the whole tool is about the
 * part in the middle. Drawn with a clip path rather than arc maths so the
 * intersection is exact by construction.
 */
function mark(cx, cy, r, overlap, id) {
  const left = cx - overlap;
  const right = cx + overlap;

  return `
  <clipPath id="${id}"><circle cx="${left}" cy="${cy}" r="${r}"/></clipPath>
  <circle cx="${left}" cy="${cy}" r="${r}" fill="none" stroke="${PALETTE.dim}" stroke-width="3"/>
  <circle cx="${right}" cy="${cy}" r="${r}" fill="none" stroke="${PALETTE.dim}" stroke-width="3"/>
  <circle cx="${right}" cy="${cy}" r="${r}" fill="${PALETTE.ramp[2]}" clip-path="url(#${id})"/>`;
}

function banner() {
  const W = 1200;
  const H = 300;
  const markCx = 150;
  const wordX = 268;
  const wordY = 96;
  /** Centred on the wordmark rather than on the panel, which reads straighter. */
  const markCy = wordY + (7 * CELL) / 2;

  const { rects, width } = wordmark(wordX, wordY);
  const bars = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`)
    .join('\n    ');

  const tagline = 'who decided this market, and what did they own';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="recuse">
  <rect width="${W}" height="${H}" rx="18" fill="${PALETTE.ink}"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="17" fill="${PALETTE.panel}" stroke="#1b1b20" stroke-width="2"/>
${mark(markCx, markCy, 52, 26, 'lens')}
  <g fill="${PALETTE.accent}">
    ${bars}
  </g>
  <text x="${wordX + 2}" y="${wordY + 7 * CELL + 42}" textLength="${width - 4}" lengthAdjust="spacingAndGlyphs"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="21" fill="${PALETTE.dim}">${tagline}</text>
  <g>
    ${PALETTE.ramp
      .map(
        (hex, i) =>
          `<rect x="${wordX + 2 + i * 30}" y="${wordY + 7 * CELL + 62}" width="22" height="7" rx="3.5" fill="${hex}"/>`,
      )
      .join('\n    ')}
  </g>
</svg>
`;
}

/** Square, for an avatar or a social card. Just the mark. */
function icon() {
  const S = 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="recuse">
  <rect width="${S}" height="${S}" rx="96" fill="${PALETTE.panel}"/>
${mark(S / 2, S / 2, 132, 66, 'lens-icon')}
</svg>
`;
}

mkdirSync(join(ROOT, 'assets'), { recursive: true });
writeFileSync(join(ROOT, 'assets/banner.svg'), banner());
writeFileSync(join(ROOT, 'assets/mark.svg'), icon());
console.log('wrote assets/banner.svg and assets/mark.svg');
