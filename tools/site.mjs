/**
 * Generates site/, a flat HTML snapshot of the current contested markets.
 *
 * No backend, no database, no auth, no client JavaScript. Every page is a file
 * on disk, which is the whole point: the running cost is zero, the URLs are
 * permanent, and a market page can be linked into an argument on Discord
 * without anyone needing to install anything.
 *
 * Run `node tools/site.mjs` after `npm run build`. It imports the compiled
 * engine directly rather than shelling out, so the numbers on these pages come
 * from the same `assess` the CLI calls and cannot drift from it.
 *
 * Every rule in DNA.md survives the port. A share never appears without its
 * denominator. A filter is never silent: the count of what was hidden and why
 * is on the index. The evidence tier is at the foot of every page. The tool
 * refuses to accuse in a terminal and it refuses here too.
 *
 * The look is the terminal, deliberately. Dark, monospace, dense, one accent
 * colour carrying one signal, which is the dispute round count, the same rule
 * the TUI runs on. A generic SaaS landing page would throw away the only thing
 * signalling this was made by someone who reads the data.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessAll } from '../dist/core/assess.js';
import { chainNote } from '../dist/sources/chain.js';
import { formatSteps } from '../dist/core/dispute.js';
import { fetchContestedMarkets } from '../dist/sources/gamma.js';
import { winnerMoney } from '../dist/core/capture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');

const SCAN = Number(process.env.SITE_SCAN ?? 600);
const PAGES = Number(process.env.SITE_PAGES ?? 60);
const ORIGIN = process.env.SITE_ORIGIN ?? 'https://xzycd.github.io/recuse';

/**
 * Escape for HTML.
 *
 * Market questions and display names already went through `core/safe.ts` on
 * ingest, which strips what a terminal would act on. A browser acts on a
 * different set, so this is the second half of the same job and neither
 * replaces the other: `<` is harmless on a terminal and is markup here.
 */
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A slug safe to use as a filename and a URL segment. */
export function pageName(a) {
  const base = a.market.slug || a.market.conditionId || '';
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    // Trimmed before the fallback, or a slug of nothing but punctuation
    // collapses to a single hyphen, which is truthy and produces `-.html`.
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return `${clean || 'market'}.html`;
}

function money(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function count(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** Cold, warm, hot. The one coloured signal, same ramp as the terminal. */
function heat(rounds) {
  return rounds === 0 ? 'r0' : rounds === 1 ? 'r1' : 'r2';
}

const CSS = `
:root{--bg:#0b0d10;--fg:#c9d1d9;--dim:#6e7681;--rule:#1c2128;--accent:#d29922;
--r0:#4d5560;--r1:#d29922;--r2:#e5534b;--card:#11151a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px 64px}
header{border-bottom:1px solid var(--rule);padding-bottom:16px;margin-bottom:24px}
h1{margin:0;font-size:20px;letter-spacing:.14em;color:var(--accent);font-weight:700}
h1 a{text-decoration:none}
.tag{color:var(--dim);margin-top:6px}
h2{font-size:14px;color:var(--dim);font-weight:400;margin:32px 0 10px;
letter-spacing:.06em;text-transform:lowercase}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:400;padding:6px 8px;
border-bottom:1px solid var(--rule);white-space:nowrap}
td{padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}
tbody tr:hover{background:var(--card)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.q a{text-decoration:none}
.q a:hover{color:var(--accent);text-decoration:underline}
.r0{color:var(--r0)}.r1{color:var(--r1)}.r2{color:var(--r2)}
.dim{color:var(--dim)}
.terms{color:var(--dim);font-size:12px}
.steps{color:var(--dim);letter-spacing:.06em;white-space:nowrap}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);
color:var(--dim);font-size:12px}
footer p{margin:5px 0}
code,pre{background:var(--card);border:1px solid var(--rule);border-radius:4px}
code{padding:1px 5px}
pre{padding:12px;overflow-x:auto;font-size:12.5px;line-height:1.5}
.grid{display:grid;grid-template-columns:150px 1fr;gap:4px 16px;margin:14px 0}
.grid dt{color:var(--dim)}
.grid dd{margin:0}
.side{border:1px solid var(--rule);border-radius:6px;padding:14px 16px;margin:14px 0;
background:var(--card)}
.side h3{margin:0 0 8px;font-size:13px;font-weight:400;color:var(--fg)}
.caveats{list-style:none;padding:0;margin:8px 0 0;color:var(--dim);font-size:12px}
.caveats li{margin:3px 0}
.caveats li::before{content:"· "}
.back{color:var(--dim);text-decoration:none;font-size:12px}
.back:hover{color:var(--accent)}
@media(max-width:720px){.grid{grid-template-columns:1fr}.wrap{padding:20px 14px 48px}
th:nth-child(n+5),td:nth-child(n+5){display:none}}
`;

function layout({ title, description, canonical, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

/** The footer every page carries, tier included. */
function footer(generatedAt) {
  return `<footer>
<p>${esc(chainNote())}</p>
<p>Read from public Polymarket endpoints. No accusation is made or implied: someone is on the losing side of every market, and being there is not evidence of anything on its own.</p>
<p>Generated ${esc(generatedAt)} · <a href="https://github.com/xzycd/recuse">source</a> · <code>npx recuse</code></p>
</footer>`;
}

/** A share and its terms, never the share alone. */
function shareCell(c) {
  if (!c) return '<td class="n dim">—</td>';
  return `<td class="n">${pct(c.topShare)} <span class="terms">${c.topN}/${c.holderCount}</span></td>`;
}

function indexPage(assessments, meta) {
  const rows = assessments.map((a) => {
    const n = a.dispute.rounds;
    const c = a.concentration;
    const wiped = c && c.meaning === 'wiped' ? count(c.totalSize) : '—';

    return `<tr>
<td class="q"><a href="./${esc(pageName(a))}">${esc(a.market.question)}</a></td>
<td class="n ${heat(n)}">${n > 0 ? `${n}&times;` : '·'}</td>
<td class="n">${esc(wiped)}</td>
${shareCell(c)}
<td class="n">${esc(money(a.pool))}</td>
<td class="steps">${esc(formatSteps(a.dispute.steps))}</td>
</tr>`;
  }).join('\n');

  const body = `<header>
<h1>RECUSE</h1>
<div class="tag">Polymarket settles by vote. This is the record of those votes.</div>
</header>

<p>Every market below was contested at least once: someone put up a bond to argue the proposed outcome was wrong. The colour is the round count and nothing else.</p>

<h2>contested markets</h2>
<table>
<thead><tr>
<th>market</th><th class="n">rounds</th><th class="n">wiped</th>
<th class="n">top 5 held</th><th class="n">volume</th><th>lifecycle</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>

<p class="terms">${meta.contested} contested of ${meta.scanned} markets examined, showing ${assessments.length}. ${meta.scanned - meta.contested} were never contested and are not listed.</p>

<h2>the part other tools cannot show you</h2>
<p>When a market settles, winners redeem their tokens for a dollar each and their balances go to zero. Losers keep theirs, because there is nothing to redeem them for. So the holder list of a settled market is almost entirely the people who lost, and every balance-based tracker is blind to the side that won.</p>
<p>On the Zelenskyy market the winning side reads as <strong>907 tokens</strong> in current balances and <strong>71,435,381</strong> in cumulative buys. The largest winner does not appear in the holder list at all.</p>
<p>These pages rebuild that side from trades.</p>

<h2>in a terminal</h2>
<pre>npx recuse                    contested markets, most contested first
npx recuse queue              resolutions that have not finished
npx recuse market &lt;slug&gt;      one market, both sides of it
npx recuse winners &lt;slug&gt;     who bought the side that won</pre>

${footer(meta.generatedAt)}`;

  return layout({
    title: 'recuse · the record behind Polymarket resolutions',
    description: `${meta.contested} contested Polymarket markets: how many dispute rounds each went through, who was wiped out, and who bought the side that won.`,
    canonical: `${ORIGIN}/`,
    body,
  });
}

function marketPage(a, generatedAt) {
  const c = a.concentration;
  const wc = a.winnerConcentration;
  const n = a.dispute.rounds;
  const m = a.winners ? winnerMoney(a.winners) : undefined;

  const losing = c ? `<div class="side">
<h3>${esc(c.side)} ${c.meaning === 'wiped' ? 'lost' : 'leads'}${c.meaning === 'wiped' ? `, ${esc(count(c.totalSize))} tokens went to zero` : ', market still open'}</h3>
<div>top ${c.topN} of ${c.holderCount} holders held <strong>${pct(c.topShare)}</strong> <span class="terms">(${esc(count(c.topSize))} of ${esc(count(c.totalSize))} tokens, from balances)</span></div>
</div>` : '';

  const winning = wc ? `<div class="side">
<h3>${esc(wc.side)} won, ${esc(count(wc.totalSize))} tokens rebuilt from trades</h3>
<div>top ${wc.topN} of ${wc.holderCount} wallets bought <strong>${pct(wc.topShare)}</strong> <span class="terms">(${esc(count(wc.topSize))} of ${esc(count(wc.totalSize))} tokens, from cumulative buys)</span></div>
${m ? `<div style="margin-top:6px">they paid <strong>${esc(money(m.paid))}</strong> and redeemed <strong>${esc(money(m.redeemed))}</strong> <span class="terms">(${m.wallets} wallets read)</span></div>` : ''}
<div class="terms" style="margin-top:6px">Balances show almost none of this. These wallets redeemed and left the book.</div>
</div>` : '';

  const winnerRows = (a.winners ?? []).slice(0, 20).map((w) => {
    const avg = w.net > 0 ? (w.netSpent / w.net).toFixed(2) : '—';
    return `<tr>
<td>${esc(w.name ? `${w.name} ` : '')}<span class="dim">${esc(w.address)}</span></td>
<td class="n">${esc(count(w.bought))}</td>
<td class="n">${esc(count(w.net))}</td>
<td class="n">${esc(money(w.netSpent))}</td>
<td class="n">${esc(avg)}</td>
<td class="n">${esc(money(w.net - w.netSpent))}</td>
</tr>`;
  }).join('\n');

  const winnerTable = winnerRows ? `<h2>who bought the side that won</h2>
<table>
<thead><tr><th>wallet</th><th class="n">bought</th><th class="n">held</th>
<th class="n">paid</th><th class="n">avg</th><th class="n">gain</th></tr></thead>
<tbody>${winnerRows}</tbody>
</table>
<p class="terms">Every token held on the winning side redeems for exactly one dollar, so the gain is arithmetic rather than an estimate. A name is chosen by the account holder and never replaces the address it sits beside.</p>` : '';

  const body = `<header>
<h1><a href="./index.html">RECUSE</a></h1>
<div class="tag"><a class="back" href="./index.html">&larr; all contested markets</a></div>
</header>

<h2 style="margin-top:20px">${esc(a.market.question)}</h2>

<dl class="grid">
<dt>disputes</dt><dd class="${heat(n)}">${n > 0 ? `${n} round${n === 1 ? '' : 's'}` : 'never contested'}</dd>
<dt>lifecycle</dt><dd class="steps">${esc(formatSteps(a.dispute.steps))}</dd>
<dt>phase</dt><dd>${esc(a.dispute.phase)}</dd>
<dt>volume</dt><dd>${esc(money(a.pool))}</dd>
${a.market.umaBond ? `<dt>bond</dt><dd>$${esc(a.market.umaBond)}</dd>` : ''}
<dt>condition id</dt><dd class="dim" style="word-break:break-all">${esc(a.market.conditionId)}</dd>
</dl>

${losing}
${winning}
${winnerTable}

${a.market.resolutionSource ? `<h2>resolution source</h2><p class="terms">${esc(a.market.resolutionSource)}</p>` : ''}

${a.caveats.length ? `<h2>what this reading does not cover</h2>
<ul class="caveats">${a.caveats.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}

<h2>check it yourself</h2>
<pre>npx recuse market ${esc(a.market.slug || a.market.conditionId)}
npx recuse winners ${esc(a.market.slug || a.market.conditionId)} --json</pre>
<p class="terms">${a.market.slug ? `<a href="https://polymarket.com/event/${esc(a.market.slug)}">This market on Polymarket</a>` : ''}</p>

${footer(generatedAt)}`;

  const rounds = n > 0 ? `${n} dispute round${n === 1 ? '' : 's'}` : 'never contested';
  return layout({
    title: `${a.market.question} · recuse`,
    description: `${rounds}, ${money(a.pool)} traded.${c && c.meaning === 'wiped' ? ` ${count(c.totalSize)} tokens on the ${c.side} side went to zero.` : ''}`,
    canonical: `${ORIGIN}/${pageName(a)}`,
    body,
  });
}

async function main() {
  process.stderr.write(`scanning ${SCAN} markets\n`);
  const { markets, scanned } = await fetchContestedMarkets(SCAN);

  const shown = markets.slice(0, PAGES);
  process.stderr.write(`${markets.length} contested, building ${shown.length} pages\n`);

  const assessments = await assessAll(shown, { winners: true, winnerNames: true }, (done, total) => {
    if (done % 5 === 0 || done === total) process.stderr.write(`  ${done}/${total}\n`);
  });

  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  writeFileSync(
    join(OUT, 'index.html'),
    indexPage(assessments, { scanned, contested: markets.length, generatedAt }),
  );

  const urls = ['/'];
  for (const a of assessments) {
    const name = pageName(a);
    writeFileSync(join(OUT, name), marketPage(a, generatedAt));
    urls.push(`/${name}`);
  }

  // The whole dataset, so anyone can check a page against its source without
  // running anything. Same shape the CLI emits.
  writeFileSync(
    join(OUT, 'data.json'),
    `${JSON.stringify({ generatedAt, scanned, contested: markets.length, assessments }, null, 2)}\n`,
  );

  writeFileSync(
    join(OUT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
      urls.map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join('\n')
    }\n</urlset>\n`,
  );

  writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  // Tells GitHub Pages not to run these through Jekyll.
  writeFileSync(join(OUT, '.nojekyll'), '');

  process.stderr.write(`wrote ${urls.length} pages to site/\n`);
}

// Only when invoked directly, so the helpers above stay importable and the
// escaping can be tested. Same reason cli.ts guards its own entry point.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exitCode = 1;
  });
}
