import { z } from "zod";

export const SymbolKindSchema = z.enum([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "const",
]);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

export const SymbolIdSchema = z.string().regex(/^s_[0-9]+$/);
export type SymbolId = z.infer<typeof SymbolIdSchema>;

export const MatchSourceSchema = z.enum(["name", "doc", "signature"]);
export type MatchSource = z.infer<typeof MatchSourceSchema>;

export const ReferenceKindSchema = z.enum([
  "call",
  "import",
  "type_use",
  "other",
]);
export type ReferenceKind = z.infer<typeof ReferenceKindSchema>;

export const ErrorCodeSchema = z.enum([
  "INVALID_ARGS",
  "UNKNOWN_SYMBOL",
  "DENIED_PATH",
  "BUDGET_EXCEEDED",
  "TIMEOUT",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SymbolSummarySchema = z.object({
  symbol_id: SymbolIdSchema,
  name: z.string().min(1),
  kind: SymbolKindSchema,
  file: z.string().min(1),
  line: z.number().int().min(1),
  exported: z.boolean(),
  is_test: z.boolean(),
  signature: z.string().max(300),
  doc_summary: z.string().max(200).nullable(),
});
export type SymbolSummary = z.infer<typeof SymbolSummarySchema>;

export const SearchSymbolsInputSchema = z
  .object({
    query: z.string().trim().min(1).max(100),
    kind: SymbolKindSchema.optional(),
    path_prefix: z.string().min(1).optional(),
    include_tests: z.boolean().default(false),
    limit: z.number().int().min(1).max(10).default(5),
  })
  .strict();
export type SearchSymbolsInput = z.infer<typeof SearchSymbolsInputSchema>;

export const GetDefinitionInputSchema = z
  .object({
    symbol_id: SymbolIdSchema,
    max_lines: z.number().int().min(1).max(120).default(60),
  })
  .strict();
export type GetDefinitionInput = z.infer<typeof GetDefinitionInputSchema>;

export const GetReferencesInputSchema = z
  .object({
    symbol_id: SymbolIdSchema,
    kinds: z.array(ReferenceKindSchema).optional(),
    include_tests: z.boolean().default(false),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export type GetReferencesInput = z.infer<typeof GetReferencesInputSchema>;

export const GetSignatureInputSchema = z
  .object({
    symbol_id: SymbolIdSchema,
    compare_to: SymbolIdSchema.optional(),
  })
  .strict();
export type GetSignatureInput = z.infer<typeof GetSignatureInputSchema>;

export const SearchResultItemSchema = SymbolSummarySchema.extend({
  match: MatchSourceSchema,
});
export type SearchResultItem = z.infer<typeof SearchResultItemSchema>;

export const SearchSymbolsOutputSchema = z.object({
  results: z.array(SearchResultItemSchema),
  truncated: z.boolean(),
});
export type SearchSymbolsOutput = z.infer<typeof SearchSymbolsOutputSchema>;

export const ImportUsageSchema = z.object({
  module: z.string().min(1),
  names: z.array(z.string()),
});
export type ImportUsage = z.infer<typeof ImportUsageSchema>;

export const GetDefinitionOutputSchema = z.object({
  symbol: SymbolSummarySchema,
  range: z.object({
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1),
  }),
  body: z.string(),
  body_truncated: z.boolean(),
  line_count: z.number().int().min(0),
  imports_used: z.array(ImportUsageSchema),
  in_current_diff: z.literal(false),
  deprecated: z.boolean(),
});
export type GetDefinitionOutput = z.infer<typeof GetDefinitionOutputSchema>;

export const ReferenceByFileSchema = z.object({
  file: z.string().min(1),
  count: z.number().int().min(0),
});
export type ReferenceByFile = z.infer<typeof ReferenceByFileSchema>;

export const ReferenceEntrySchema = z.object({
  file: z.string().min(1),
  line: z.number().int().min(1),
  kind: ReferenceKindSchema,
  enclosing_symbol_id: SymbolIdSchema.nullable(),
  context: z.string().max(200),
});
export type ReferenceEntry = z.infer<typeof ReferenceEntrySchema>;

export const GetReferencesOutputSchema = z.object({
  total: z.number().int().min(0),
  by_file: z.array(ReferenceByFileSchema),
  references: z.array(ReferenceEntrySchema),
  truncated: z.boolean(),
});
export type GetReferencesOutput = z.infer<typeof GetReferencesOutputSchema>;

export const SignatureParamSchema = z.object({
  name: z.string().min(1),
  type: z.string(),
  optional: z.boolean(),
});
export type SignatureParam = z.infer<typeof SignatureParamSchema>;

export const SignatureCompatSchema = z.object({
  same_param_count: z.boolean(),
  params_assignable: z.union([z.boolean(), z.literal("unknown")]),
  return_assignable: z.union([z.boolean(), z.literal("unknown")]),
  async_match: z.boolean(),
});
export type SignatureCompat = z.infer<typeof SignatureCompatSchema>;

export const GetSignatureOutputSchema = z.object({
  name: z.string().min(1),
  type_signature: z.string(),
  params: z.array(SignatureParamSchema),
  return_type: z.string(),
  type_params: z.array(z.string()),
  is_async: z.boolean(),
  exported: z.boolean(),
  compat: SignatureCompatSchema.optional(),
});
export type GetSignatureOutput = z.infer<typeof GetSignatureOutputSchema>;

export const ToolErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const OkEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});
export type OkEnvelope = z.infer<typeof OkEnvelopeSchema>;

export const ErrEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: ToolErrorSchema,
});
export type ErrEnvelope = z.infer<typeof ErrEnvelopeSchema>;

export const ResultEnvelopeSchema = z.union([
  OkEnvelopeSchema,
  ErrEnvelopeSchema,
]);
export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true as const, data };
}

export function err(
  code: ErrorCode,
  message: string,
): { ok: false; error: { code: ErrorCode; message: string } } {
  return { ok: false as const, error: { code, message } };
}



