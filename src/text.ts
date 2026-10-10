/**
 * Tokenization and light stemming for search_symbols (Task 10).
 *
 * Both are pure, dependency-free and are applied identically to indexed text
 * (names, doc text, signatures) and to query text, so a query can only ever
 * match tokens the index actually holds.
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

/** -es only after a sibilant stem: processes, boxes, watches, dishes, statuses. */
const SIBILANT_ES = /(?:ss|s|x|z|ch|sh)es$/;

/**
 * Light, hand-written stemmer shared by indexing and querying. No dependency.
 *
 * Rule order (first match wins, then the trailing-e rule):
 *   0. tokens of 3 chars or fewer are returned unchanged
 *   1. -ies  -> -y    (applies -> apply)
 *   2. -es after s/x/z/ch/sh -> drop -es   (processes -> process, statuses -> status)
 *   3. -s, never -ss/-us/-is -> drop -s    (alerts -> alert; class, status, analysis kept)
 *   4. -ied  -> -y    (applied -> apply)
 *   5. -ed   -> drop -ed   (suppressed -> suppress)
 *   6. -ing  -> drop -ing  (throttling -> throttl)
 *   7. drop one trailing -e  (throttle -> throttl, code -> cod)
 *   8. if the result is shorter than 3 chars, keep the original token
 *
 * Over-conflation (news -> new, cases -> cas) is accepted because the rule is
 * applied identically on both sides; exact-token matches still score higher
 * than stem-only matches (see docs/SPEC.md).
 */
export function stemToken(token: string): string {
  if (token.length <= 3) return token;
  let stem = token;
  if (stem.endsWith("ies")) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (SIBILANT_ES.test(stem)) {
    stem = stem.slice(0, -2);
  } else if (
    stem.endsWith("s") &&
    !stem.endsWith("ss") &&
    !stem.endsWith("us") &&
    !stem.endsWith("is")
  ) {
    stem = stem.slice(0, -1);
  } else if (stem.endsWith("ied")) {
    stem = `${stem.slice(0, -3)}y`;
  } else if (stem.endsWith("ed")) {
    stem = stem.slice(0, -2);
  } else if (stem.endsWith("ing")) {
    stem = stem.slice(0, -3);
  }
  if (stem.endsWith("e")) stem = stem.slice(0, -1);
  return stem.length >= 3 ? stem : token;
}

/** The stem set of a token set, computed once per symbol. */
export function stemAll(tokens: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const token of tokens) stems.add(stemToken(token));
  return stems;
}
