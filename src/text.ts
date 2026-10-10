/**
 * Tokenization for search_symbols (Task 10).
 *
 * Pure and dependency-free; applied identically to indexed text (names, doc
 * text, signatures) and to query text, so a query can only ever match tokens
 * the index actually holds.
 */

const CAMEL_LOWER_UPPER = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
const LETTER_DIGIT = /([A-Za-z])([0-9])/g;
const DIGIT_LETTER = /([0-9])([A-Za-z])/g;
const NON_ALNUM = /[^A-Za-z0-9]+/;

/**
 * Split on non-alphanumerics, camelCase boundaries and letter/digit
 * boundaries; lowercase; drop empty tokens.
 *
 * Every maximal identifier is indexed BOTH whole and split, so an exact name
 * keeps matching while its parts become reachable:
 *   round2       -> round2, round, 2
 *   base64Encode -> base64encode, base64, base, 64, encode
 *   v2Handler    -> v2handler, v2, v, 2, handler
 *   parse_user_id-> parse, user, id
 *   HTTPServer   -> httpserver, http, server
 *
 * There is no minimum length or stopword rule, so pure-digit tokens (`2`,
 * `64`) ARE indexed. That is a deliberate consequence of splitting at
 * letter/digit boundaries; see docs/SPEC.md.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string): void => {
    const lower = raw.toLowerCase();
    if (lower.length > 0) tokens.add(lower);
  };
  for (const word of text.split(NON_ALNUM)) {
    if (word.length === 0) continue;
    // The whole identifier, camelCase intact ("base64encode").
    add(word);
    const spaced = word
      .replace(CAMEL_LOWER_UPPER, "$1 $2")
      .replace(ACRONYM_BOUNDARY, "$1 $2");
    for (const part of spaced.split(NON_ALNUM)) {
      if (part.length === 0) continue;
      add(part);
      const pieces = part
        .replace(LETTER_DIGIT, "$1 $2")
        .replace(DIGIT_LETTER, "$1 $2");
      for (const piece of pieces.split(NON_ALNUM)) {
        if (piece.length > 0) add(piece);
      }
    }
  }
  return tokens;
}
