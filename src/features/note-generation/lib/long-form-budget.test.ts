import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FALLBACK_MODEL_LIMITS, longFormBudgetFor } from "./long-form-budget.ts";

describe("longFormBudgetFor", () => {
  it("leaves room for the reduce input plus three output windows inside the context", () => {
    const limits = { ...FALLBACK_MODEL_LIMITS, context_tokens: 32_768 };
    const budget = longFormBudgetFor(limits);
    assert.ok(budget.maxReduceTokens + budget.globalOutputTokens * 3 <= limits.context_tokens);
    assert.ok(budget.maxSourceTokens + budget.sectionOutputTokens * 3 <= limits.context_tokens);
  });

  it("never plans outputs larger than the model allows", () => {
    const budget = longFormBudgetFor({ ...FALLBACK_MODEL_LIMITS, context_tokens: 200_000, max_output_tokens: 1_000 });
    assert.equal(budget.sectionOutputTokens, 1_000);
    assert.equal(budget.globalOutputTokens, 1_000);
  });

  it("keeps a usable floor for tiny context windows", () => {
    const budget = longFormBudgetFor({ ...FALLBACK_MODEL_LIMITS, context_tokens: 1_000 });
    assert.ok(budget.sectionOutputTokens >= 512);
    assert.ok(budget.maxReduceTokens >= 512);
  });
});
