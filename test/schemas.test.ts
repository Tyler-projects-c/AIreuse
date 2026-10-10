import { describe, expect, it } from "vitest";
import {
  ErrEnvelopeSchema,
  GetDefinitionInputSchema,
  GetDefinitionOutputSchema,
  GetReferencesInputSchema,
  GetSignatureInputSchema,
  OkEnvelopeSchema,
  ReferenceKindSchema,
  ResultEnvelopeSchema,
  SearchSymbolsInputSchema,
  err,
  ok,
} from "../src/schemas.js";

describe("schemas", () => {
  it("parses valid inputs", () => {
    expect(
      SearchSymbolsInputSchema.parse({ query: "foo" }),
    ).toMatchObject({ query: "foo" });
    expect(
      GetDefinitionInputSchema.parse({ symbol_id: "s_1" }),
    ).toMatchObject({ symbol_id: "s_1" });
    expect(
      GetReferencesInputSchema.parse({ symbol_id: "s_2" }),
    ).toMatchObject({ symbol_id: "s_2" });
    expect(
      GetSignatureInputSchema.parse({ symbol_id: "s_3" }),
    ).toMatchObject({ symbol_id: "s_3" });
  });

  it("rejects empty query", () => {
    expect(() =>
      SearchSymbolsInputSchema.parse({ query: "" }),
    ).toThrow();
  });

  it("rejects limit 11", () => {
    expect(() =>
      SearchSymbolsInputSchema.parse({ query: "foo", limit: 11 }),
    ).toThrow();
  });

  it("rejects max_lines 121", () => {
    expect(() =>
      GetDefinitionInputSchema.parse({ symbol_id: "s_1", max_lines: 121 }),
    ).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      SearchSymbolsInputSchema.parse({ query: "foo", bogus: 1 }),
    ).toThrow();
    expect(() =>
      GetDefinitionInputSchema.parse({ symbol_id: "s_1", bogus: 1 }),
    ).toThrow();
    expect(() =>
      GetReferencesInputSchema.parse({ symbol_id: "s_1", bogus: 1 }),
    ).toThrow();
    expect(() =>
      GetSignatureInputSchema.parse({ symbol_id: "s_1", bogus: 1 }),
    ).toThrow();
  });

  it("applies defaults by parsing", () => {
    expect(SearchSymbolsInputSchema.parse({ query: "foo" })).toMatchObject({
      include_tests: false,
      limit: 5,
      offset: 0,
    });
    expect(GetDefinitionInputSchema.parse({ symbol_id: "s_1" })).toMatchObject({
      max_lines: 60,
    });
    expect(GetReferencesInputSchema.parse({ symbol_id: "s_1" })).toMatchObject({
      include_tests: false,
      limit: 10,
    });
  });

  it("ok() and err() produce valid envelopes", () => {
    const good = ok({ hello: "world" });
    expect(OkEnvelopeSchema.parse(good).ok).toBe(true);
    expect(ResultEnvelopeSchema.parse(good).ok).toBe(true);
    const bad = err("INVALID_ARGS", "bad input");
    expect(ErrEnvelopeSchema.parse(bad).ok).toBe(false);
    expect(ResultEnvelopeSchema.parse(bad).ok).toBe(false);
  });

  it("rejects whitespace-only query", () => {
    expect(() =>
      SearchSymbolsInputSchema.parse({ query: "   " }),
    ).toThrow();
  });

  it("search limit boundaries", () => {
    expect(
      SearchSymbolsInputSchema.parse({ query: "foo", limit: 10 }),
    ).toMatchObject({ limit: 10 });
    expect(() =>
      SearchSymbolsInputSchema.parse({ query: "foo", limit: 0 }),
    ).toThrow();
  });

  it("max_lines boundaries", () => {
    expect(
      GetDefinitionInputSchema.parse({ symbol_id: "s_1", max_lines: 120 }),
    ).toMatchObject({ max_lines: 120 });
    expect(() =>
      GetDefinitionInputSchema.parse({ symbol_id: "s_1", max_lines: 0 }),
    ).toThrow();
  });

  it("get_references limit boundaries", () => {
    expect(
      GetReferencesInputSchema.parse({ symbol_id: "s_1", limit: 20 }),
    ).toMatchObject({ limit: 20 });
    expect(() =>
      GetReferencesInputSchema.parse({ symbol_id: "s_1", limit: 21 }),
    ).toThrow();
  });

  it('reference kind accepts "other"', () => {
    expect(ReferenceKindSchema.parse("other")).toBe("other");
    expect(
      GetReferencesInputSchema.parse({
        symbol_id: "s_1",
        kinds: ["call", "import", "type_use", "other"],
      }),
    ).toMatchObject({ kinds: ["call", "import", "type_use", "other"] });
  });

  it("definition output rejects in_current_diff true", () => {
    const base = {
      symbol: {
        symbol_id: "s_1",
        name: "foo",
        kind: "function",
        file: "src/a.ts",
        line: 1,
        exported: true,
        is_test: false,
        signature: "foo()",
        doc_summary: null,
      },
      range: { start_line: 1, end_line: 3 },
      body: "function foo() {}",
      body_truncated: false,
      line_count: 3,
      imports_used: [],
      in_current_diff: true,
      deprecated: false,
    };
    expect(() => GetDefinitionOutputSchema.parse(base)).toThrow();
    expect(
      GetDefinitionOutputSchema.parse({ ...base, in_current_diff: false }),
    ).toMatchObject({ in_current_diff: false });
  });
});

