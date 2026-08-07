/**
 * Generates assets/banner.svg, assets/mark.svg and assets/social.svg.
 *
 * The wordmark here is the same letterform grid the terminal splash draws with
 * half blocks, so the README and the program are showing the same shapes rather
 * than two designs that happen to share a name. Run `node tools/logo.mjs` after
 * changing either one.
 *
 * The face is an X-eyed smiley. It is not decoration: X eyes are the universal
 * shorthand for wiped out, and what this tool measures is exactly that, the side
 * of a market whose tokens went to zero. It is drawn deliberately lopsided,
 * because a perfectly symmetrical one looks like a corporate mascot.
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
  face: '#d9a441',
};

/**
 * The face.
 *
 * Everything is drawn relative to `r`, so one number scales it. The wobble is
 * deliberate and consistent: the right eye sits lower and slightly wider than
 * the left, the smile is not centred, and the tongue hangs off one side. A
 * symmetrical version of this reads as a stock icon.
 *
 * `stroke-linecap="round"` throughout, because the reference is a marker pen.
 */
function face(cx, cy, r, colour, id) {
  const w = r * 0.16;
  // Left eye sits a touch higher and tighter than the right. The asymmetry is
  // the whole character of it and is worth more than any amount of polish.
  const eyeL = { x: cx - r * 0.4, y: cy - r * 0.3, s: r * 0.165 };
  const eyeR = { x: cx + r * 0.37, y: cy - r * 0.26, s: r * 0.195 };

  const cross = (e) => `
    <path d="M${e.x - e.s} ${e.y - e.s} L${e.x + e.s} ${e.y + e.s}"/>
    <path d="M${e.x + e.s} ${e.y - e.s} L${e.x - e.s} ${e.y + e.s}"/>`;

  // The smile is a quadratic pulled off centre, so its low point sits right of
  // the middle. Both ends stay well below the eyes: at the first attempt the
  // right end curled up into the right eye and the two shapes merged into one
  // unreadable blob at favicon size.
  const mouthY = cy + r * 0.3;
  const smile = `M${cx - r * 0.5} ${mouthY} Q${cx + r * 0.04} ${cy + r * 0.84} ${cx + r * 0.53} ${mouthY - r * 0.02}`;

  return `
  <g id="${id}" fill="none" stroke="${colour}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke-width="${w * 1.15}"/>
    ${cross(eyeL)}
    ${cross(eyeR)}
    <path d="${smile}"/>
    <path d="M${cx + r * 0.31} ${mouthY + r * 0.28} q${r * 0.15} ${r * 0.24} ${-r * 0.15} ${r * 0.26}" stroke-width="${w * 0.9}"/>
  </g>`;
}

function banner() {
  const W = 1200;
  const H = 300;
  const wordX = 300;
  const wordY = 96;
  const markCy = wordY + (7 * CELL) / 2;

  const { rects, width } = wordmark(wordX, wordY);
  const bars = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`)
    .join('\n    ');

  const tagline = 'who decided this market, and what did they own';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="recuse">
  <rect width="${W}" height="${H}" rx="18" fill="${PALETTE.ink}"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="17" fill="${PALETTE.panel}" stroke="#1b1b20" stroke-width="2"/>
${face(166, markCy, 62, PALETTE.face, 'face-banner')}
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

/** Square, for an avatar or a favicon. Just the face. */
function icon() {
  const S = 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="recuse">
  <rect width="${S}" height="${S}" rx="96" fill="${PALETTE.panel}"/>
${face(S / 2, S / 2 - 6, 152, PALETTE.face, 'face-icon')}
</svg>
`;
}

/**
 * The GitHub social preview, 1280x640.
 *
 * Different from the banner on purpose: this one is seen at thumbnail size in a
 * timeline, so it carries the face large and one number rather than a tagline
 * nobody can read at that scale.
 */
function social() {
  const W = 1280;
  const H = 640;
  const { rects, width } = wordmark(438, 250);
  const bars = rects
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`)
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="recuse">
  <rect width="${W}" height="${H}" fill="${PALETTE.panel}"/>
${face(268, 320, 118, PALETTE.face, 'face-social')}
  <g fill="${PALETTE.accent}">
    ${bars}
  </g>
  <text x="440" y="392" textLength="${width - 2}" lengthAdjust="spacingAndGlyphs"
        font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="25" fill="${PALETTE.dim}">who decided this market, and what did they own</text>
  <text x="440" y="436" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="25" fill="${PALETTE.ramp[2]}">1,150 disputed markets in 2026</text>
</svg>
`;
}

mkdirSync(join(ROOT, 'assets'), { recursive: true });
writeFileSync(join(ROOT, 'assets/banner.svg'), banner());
writeFileSync(join(ROOT, 'assets/mark.svg'), icon());
writeFileSync(join(ROOT, 'assets/social.svg'), social());
console.log('wrote assets/banner.svg, assets/mark.svg and assets/social.svg');

// The PNG for GitHub's social preview has to be uploaded by hand, in Settings,
// since the API does not expose it. To regenerate it on macOS:
//
//   sed 's|viewBox="0 0 1280 640" width="1280" height="640"|viewBox="0 -320 1280 1280" width="1280" height="1280"|' \
//     assets/social.svg > /tmp/square.svg
//   qlmanage -t -s 1280 -o /tmp /tmp/square.svg
//   sips -c 640 1280 /tmp/square.svg.png --out assets/social-preview.png
//
// The square wrapper is not optional: qlmanage always renders into a square
// canvas and fits by height, so a 2:1 image rendered directly comes out at
// double scale with the right-hand third cut off.
