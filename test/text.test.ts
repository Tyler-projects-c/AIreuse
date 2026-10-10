import { describe, expect, it } from "vitest";
import { stemAll, stemToken, tokenize } from "../src/text.js";

describe("tokenize", () => {
  it("splits camelCase, snake_case, kebab-case and letter/digit boundaries", () => {
    const cases: [string, string[]][] = [
      ["round2", ["round2", "round", "2"]],
      ["base64Encode", ["base64encode", "base64", "base", "64", "encode"]],
      ["v2Handler", ["v2handler", "v2", "v", "2", "handler"]],
      ["HTML5Parser", ["html5parser", "html5", "html", "5", "parser"]],
      ["s3Client", ["s3client", "s3", "s", "3", "client"]],
      ["parse_user_id", ["parse", "user", "id"]],
      ["kebab-name", ["kebab", "name"]],
      // Existing camelCase behaviour is unchanged (plus the whole identifier).
      ["exportCsv", ["exportcsv", "export", "csv"]],
      ["HTTPServer", ["httpserver", "http", "server"]],
      ["getShippingCost", ["getshippingcost", "get", "shipping", "cost"]],
    ];
    for (const [input, expected] of cases) {
      expect([...tokenize(input)].sort(), input).toEqual([...expected].sort());
    }
  });

  it("indexes pure-digit tokens as a consequence of digit splitting", () => {
    expect([...tokenize("round2")].sort()).toEqual(["2", "round", "round2"]);
    expect(tokenize("base64Encode").has("64")).toBe(true);
    expect(tokenize("s3Client").has("3")).toBe(true);
  });

  it("returns no tokens for empty or punctuation-only text", () => {
    expect([...tokenize("")]).toEqual([]);
    expect([...tokenize("   ---   ")]).toEqual([]);
  });
});

/** Fixed token -> stem table. Changing the stemmer must change this table. */
const STEM_TABLE: [string, string][] = [
  // Required coverage: suppress / alert / throttle / apply families.
  ["suppress", "suppress"],
  ["suppressed", "suppress"],
  ["suppressing", "suppress"],
  ["suppresses", "suppress"],
  ["alert", "alert"],
  ["alerts", "alert"],
  ["throttle", "throttl"],
  ["throttled", "throttl"],
  ["throttling", "throttl"],
  ["throttles", "throttl"],
  ["apply", "apply"],
  ["applies", "apply"],
  ["applied", "apply"],
  ["applying", "apply"],
  // Guardrails: -ss, -us and -is endings must never be mangled.
  ["class", "class"],
  ["classes", "class"],
  ["status", "status"],
  ["statuses", "status"],
  ["process", "process"],
  ["processes", "process"],
  ["analysis", "analysis"],
  ["pass", "pass"],
  ["passed", "pass"],
  // Plural -s, -es and the sibilant rule.
  ["decimals", "decimal"],
  ["decimal", "decimal"],
  ["copies", "copy"],
  ["copy", "copy"],
  // Trailing -e is dropped so -ed/-ing forms of the same word agree.
  ["value", "valu"],
  ["values", "valu"],
  ["code", "cod"],
  ["codes", "cod"],
  ["file", "fil"],
  ["files", "fil"],
  ["name", "nam"],
  ["names", "nam"],
  ["image", "imag"],
  ["images", "imag"],
  ["base", "bas"],
  ["based", "bas"],
  ["encode", "encod"],
  ["encoded", "encod"],
  ["encoding", "encod"],
  ["connect", "connect"],
  ["connects", "connect"],
  ["connected", "connect"],
  ["connecting", "connect"],
  // Digit tokens are untouched; the whole-identifier token still plural-stems.
  ["round2", "round2"],
  ["roundupcents", "roundupcent"],
  // Guardrail: the result would be shorter than 3 chars, so keep the original.
  ["uses", "uses"],
  ["ties", "ties"],
  ["the", "the"],
  ["use", "use"],
  ["bus", "bus"],
  ["css", "css"],
];

describe("stemToken", () => {
  it("locks the fixed token -> stem table (>= 25 pairs)", () => {
    expect(STEM_TABLE.length).toBeGreaterThanOrEqual(25);
    for (const [token, stem] of STEM_TABLE) {
      expect(stemToken(token), token).toBe(stem);
    }
  });

  it("never stems a token of 3 characters or fewer", () => {
    for (const token of ["the", "api", "css", "got", "id", "ss", "s"]) {
      expect(stemToken(token), token).toBe(token);
    }
  });

  it("keeps -ss/-us/-is endings intact even when longer", () => {
    for (const token of ["class", "status", "analysis", "process"]) {
      expect(stemToken(token), token).toBe(token);
    }
  });

  it("is idempotent over the table's outputs", () => {
    for (const [, stem] of STEM_TABLE) {
      expect(stemToken(stem), stem).toBe(stem);
    }
  });

  it("stems every token of a token set", () => {
    expect([...stemAll(tokenize("suppressed alerts"))].sort()).toEqual([
      "alert",
      "suppress",
    ]);
  });
});
