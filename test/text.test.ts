import { describe, expect, it } from "vitest";
import { tokenize } from "../src/text.js";

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
