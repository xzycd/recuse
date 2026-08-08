/**
 * Which symbols the program can actually get to, starting from its entry point.
 *
 * Pure, and separate from `housekeeping.mjs` so it can be tested against
 * synthetic files rather than only against this repo on a day it happens to be
 * clean. A check with no failing test is the same shape as the bug it exists to
 * catch: it reads as working right up until it silently is not.
 *
 * Why reachability rather than reference counting. The chain layer deleted in
 * 0.6.0 was eight exports that called each other. `actorsInRange` called
 * `scanLogs`, `scanLogs` called `call`, `classifyOracleLog` called
 * `addressFromTopic` and had three passing tests of its own. Every symbol in it
 * had references. None of them was reachable from `cli.ts`, and nothing that
 * cluster computed was ever printed. Counting mentions cannot tell a live call
 * graph from an island; walking out from the entry point can.
 */

/**
 * Comments are not references.
 *
 * This is load bearing rather than tidiness. `chain.ts` opened with the
 * sentence "`Chain` is never constructed", and a reference count read that
 * warning as three uses of `Chain`, so the file documenting its own deadness
 * was the reason the analysis called it alive.
 *
 * Written as a scanner rather than as two regexes because both shortcuts are
 * wrong in a way that matters here. Stripping `//` to end of line eats the
 * scheme out of every URL in the file, and every source module holds an https
 * string. Only stripping `//` at the start of a line, which is what this did
 * first, misses a trailing comment, and a trailing mention of a symbol is
 * enough to keep a dead one alive.
 *
 * String contents are deliberately kept. Dropping them is more precise in
 * principle and was tried, and it produced two false positives immediately:
 * `${BASE}/markets?${params}` collapsed to `BASEparams`, so `BASE` looked
 * unreachable in two modules at once, and the `'` inside the character class
 * of `/[^\s'"]+/` opened a string that swallowed the rest of its line. Getting
 * either right needs a real parser, and both failures point the same way, at a
 * check reporting live code as dead.
 *
 * So quote state is tracked only to decide whether a `/` begins a comment, and
 * every non-comment character survives. The cost is a symbol whose name also
 * appears inside a string literal, which stays marked reachable when it is not.
 * That direction is the right one to be wrong in: a missed piece of dead code
 * is a check that was quiet, and a false alarm is a check that gets deleted.
 */
export function stripComments(src) {
  let out = '';
  let quote = null;   // the character that opened the current string
  let block = false;  // inside a slash-star comment
  let line = false;   // inside a trailing comment, until the newline

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (block) {
      if (ch === '*' && next === '/') { block = false; i++; }
      continue;
    }

    if (line) {
      // The newline survives, so stripping a trailing comment does not join
      // the code above it to the code below it.
      if (ch === '\n') { line = false; out += ch; }
      continue;
    }

    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; }
      else if (ch === quote) quote = null;
      continue;
    }

    if (ch === '/' && next === '*') { block = true; i++; continue; }
    if (ch === '/' && next === '/') { line = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;

    out += ch;
  }

  return out;
}

/**
 * Split a source file into top level blocks, each keyed by the symbol it
 * defines. Everything before the first definition belongs to `<module>`, which
 * is module level code and always runs if the file is loaded at all.
 */
export function blocksOf(src) {
  const out = [{ name: '<module>', body: [] }];
  let cur = out[0];

  for (const line of src.split('\n')) {
    const m = line.match(
      /^export\s+(?:async\s+)?(?:abstract\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    ) || line.match(/^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/)
      || line.match(/^(?:const|let)\s+([A-Za-z_$][\w$]*)/);

    if (m) {
      cur = { name: m[1], body: [] };
      out.push(cur);
    }
    cur.body.push(line);
  }
  return out;
}

/**
 * Symbols no path from `roots` arrives at.
 *
 * `files` is a map of path to source. `roots` are paths whose module level code
 * is assumed to run. Test files are not roots and should not be passed: a
 * symbol only a test can reach is a symbol the program cannot, which is exactly
 * the case worth reporting.
 *
 * Returns `{file, name}` objects, in file order.
 */
export function unreachable(files, roots) {
  const nodes = new Map();

  for (const [file, src] of Object.entries(files)) {
    for (const b of blocksOf(stripComments(src))) {
      const key = `${file}#${b.name}`;
      const body = b.body.join('\n');
      // A `const` and a later `function` can share a name across a file only in
      // pathological cases, but merging rather than overwriting keeps the edges
      // of both instead of silently dropping one.
      if (nodes.has(key)) nodes.get(key).body += `\n${body}`;
      else nodes.set(key, { file, name: b.name, body });
    }
  }

  const byName = new Map();
  for (const [key, n] of nodes) {
    if (n.name === '<module>') continue;
    if (!byName.has(n.name)) byName.set(n.name, []);
    byName.get(n.name).push(key);
  }

  const reached = new Set();
  const frontier = [...nodes.keys()].filter((k) => roots.some((r) => k.startsWith(`${r}#`)));

  while (frontier.length > 0) {
    const key = frontier.pop();
    if (reached.has(key)) continue;
    reached.add(key);

    const node = nodes.get(key);
    if (!node) continue;

    for (const [name, keys] of byName) {
      // A symbol referring to itself is recursion, not a second symbol keeping
      // it alive. Without this a dead recursive function marks itself reached.
      if (name === node.name) continue;
      if (!new RegExp(`\\b${name}\\b`).test(node.body)) continue;
      for (const k of keys) if (!reached.has(k)) frontier.push(k);
    }
  }

  const dead = [];
  for (const [key, node] of nodes) {
    if (node.name === '<module>' || reached.has(key)) continue;
    dead.push({ file: node.file, name: node.name });
  }
  return dead;
}
