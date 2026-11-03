import assert from "node:assert/strict"
import test from "node:test"

import { DEFAULT_PATTERNS } from "../dist/config.js"
import { isRateLimitFailure, parseModelRef, sameModel } from "../dist/detect.js"

test("HTTP 429 and 529 are rate limit failures", () => {
  assert.equal(isRateLimitFailure({ status: 429 }, DEFAULT_PATTERNS), true)
  assert.equal(isRateLimitFailure({ status: 529 }, DEFAULT_PATTERNS), true)
  assert.equal(isRateLimitFailure({ status: 500, message: "internal error" }, DEFAULT_PATTERNS), false)
})

test("messages and error types are matched case-insensitively", () => {
  assert.equal(isRateLimitFailure({ message: "Rate Limit exceeded" }, DEFAULT_PATTERNS), true)
  assert.equal(isRateLimitFailure({ type: "provider.rate_limit" }, DEFAULT_PATTERNS), true)
  assert.equal(isRateLimitFailure({ message: "The provider is overloaded" }, DEFAULT_PATTERNS), true)
  assert.equal(isRateLimitFailure({ message: "invalid request" }, DEFAULT_PATTERNS), false)
})

test("custom patterns replace the defaults", () => {
  assert.equal(isRateLimitFailure({ message: "slow down" }, ["slow down"]), true)
  assert.equal(isRateLimitFailure({ message: "rate limit" }, ["slow down"]), false)
})

test("parseModelRef splits only on the first slash", () => {
  assert.deepEqual(parseModelRef("anthropic/claude-opus-4-5"), {
    providerID: "anthropic",
    id: "claude-opus-4-5",
  })
  assert.deepEqual(parseModelRef("huggingface/MiniMaxAI/MiniMax-M3.1-Flash"), {
    providerID: "huggingface",
    id: "MiniMaxAI/MiniMax-M3.1-Flash",
  })
})

test("parseModelRef supports variants and object input", () => {
  assert.deepEqual(parseModelRef("acme/reasoner#high"), {
    providerID: "acme",
    id: "reasoner",
    variant: "high",
  })
  assert.deepEqual(parseModelRef({ providerID: "acme", modelID: "reasoner" }), {
    providerID: "acme",
    id: "reasoner",
  })
})

test("parseModelRef rejects incomplete references", () => {
  assert.equal(parseModelRef("no-slash"), undefined)
  assert.equal(parseModelRef("/model"), undefined)
  assert.equal(parseModelRef("provider/"), undefined)
  assert.equal(parseModelRef({ providerID: "", id: "model" }), undefined)
})

test("sameModel compares provider and model but ignores the variant", () => {
  assert.equal(
    sameModel({ providerID: "acme", id: "reasoner" }, { providerID: "acme", id: "reasoner", variant: "high" }),
    true,
  )
  assert.equal(sameModel({ providerID: "acme", id: "reasoner" }, { providerID: "acme", id: "other" }), false)
})
