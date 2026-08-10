/**
 * Whether a commit message line adds another author or tool attribution.
 *
 * GitHub can repeat a sole maintainer's old email in a squash commit trailer.
 * It is the same person only when the complete identity already appears in the
 * history and every commit author uses the same display name.
 */
export function isDisallowedAttribution(line, knownAuthors, authorNames) {
  const trimmed = line.trim();
  const coAuthor = trimmed.match(/^co-authored-by:\s*(.*)$/i);
  const repeatsSoleAuthor =
    coAuthor !== null && authorNames.size === 1 && knownAuthors.has(coAuthor[1].trim());

  return (
    (coAuthor !== null && !repeatsSoleAuthor) || /^(generated with|🤖)/i.test(trimmed)
  );
}
