import { describe, expect, it } from "vitest";
import {
  ErrEnvelopeSchema,
  GetDefinitionInputSchema,
  GetReferencesInputSchema,
  GetSignatureInputSchema,
  OkEnvelopeSchema,
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
});

