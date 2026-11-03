import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  DEFAULT_PATTERNS,
  DEFAULT_RESUME_TEXT,
  loadConfig,
  mergeConfig,
  normalizeFallbackModel,
} from "../dist/config.js"

const DEFAULTS = {
  enabled: true,
  cooldownMs: 300_000,
  patterns: [...DEFAULT_PATTERNS],
  logging: false,
  resumeText: DEFAULT_RESUME_TEXT,
}

test("loadConfig without a file or options warns about the missing fallback model", async () => {
  const result = await loadConfig({}, { paths: [] })

  assert.equal(result.config.enabled, true)
  assert.equal(result.config.fallbackModel, undefined)
  assert.deepEqual(result.sources, [])
  assert.ok(result.warnings.some((warning) => warning.includes("No fallbackModel")))
})

test("plugin options override defaults", async () => {
  const result = await loadConfig(
    {
      enabled: false,
      fallbackModel: "acme/reasoner",
      cooldownMs: 1_000,
      patterns: ["nope"],
      logging: true,
      resumeText: "keep going",
    },
    { paths: [] },
  )

  assert.equal(result.config.enabled, false)
  assert.equal(result.config.fallbackModel, "acme/reasoner")
  assert.equal(result.config.cooldownMs, 1_000)
  assert.deepEqual(result.config.patterns, ["nope"])
  assert.equal(result.config.logging, true)
  assert.equal(result.config.resumeText, "keep going")
  assert.deepEqual(result.sources, ["plugin options"])
})

test("a config file is merged with options taking precedence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rlf-config-"))
  const file = join(directory, "rate-limit-fallback.json")
  try {
    await writeFile(
      file,
      JSON.stringify({
        fallbackModel: "file/model",
        cooldownMs: 42,
        patterns: ["file pattern"],
      }),
      "utf8",
    )

    const result = await loadConfig({ fallbackModel: "option/model" }, { paths: [file] })

    assert.equal(result.config.fallbackModel, "option/model")
    assert.equal(result.config.cooldownMs, 42)
    assert.deepEqual(result.config.patterns, ["file pattern"])
    assert.deepEqual(result.sources, [file, "plugin options"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("invalid values keep the defaults and produce warnings", () => {
  const warnings = []
  const config = mergeConfig(
    { ...DEFAULTS, patterns: [...DEFAULTS.patterns] },
    {
      enabled: "yes",
      fallbackModel: { providerID: "" },
      cooldownMs: -5,
      patterns: [],
      logging: "on",
      resumeText: "",
    },
    warnings,
    "test",
  )

  assert.equal(config.enabled, true)
  assert.equal(config.fallbackModel, undefined)
  assert.equal(config.cooldownMs, 300_000)
  assert.deepEqual(config.patterns, [...DEFAULT_PATTERNS])
  assert.equal(config.logging, false)
  assert.equal(config.resumeText, DEFAULT_RESUME_TEXT)
  assert.equal(warnings.length, 6)
})

test("normalizeFallbackModel accepts strings and object forms", () => {
  assert.equal(normalizeFallbackModel("  acme/reasoner  "), "acme/reasoner")
  assert.deepEqual(normalizeFallbackModel({ providerID: "acme", id: "reasoner" }), {
    providerID: "acme",
    id: "reasoner",
  })
  assert.deepEqual(normalizeFallbackModel({ providerID: "acme", modelID: "reasoner", variant: "high" }), {
    providerID: "acme",
    id: "reasoner",
    variant: "high",
  })
  assert.equal(normalizeFallbackModel("   "), undefined)
  assert.equal(normalizeFallbackModel({ providerID: "acme" }), undefined)
  assert.equal(normalizeFallbackModel(null), undefined)
})

test("an unreadable config file is reported without aborting startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rlf-config-"))
  const file = join(directory, "rate-limit-fallback.json")
  try {
    await writeFile(file, "{ not json", "utf8")
    const result = await loadConfig({ fallbackModel: "acme/reasoner" }, { paths: [file] })

    assert.equal(result.config.fallbackModel, "acme/reasoner")
    assert.ok(result.warnings.some((warning) => warning.includes("Could not load")))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
