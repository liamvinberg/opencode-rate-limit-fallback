import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface FallbackModelObject {
  providerID: string
  id?: string
  modelID?: string
  variant?: string
}

export interface RateLimitFallbackConfig {
  enabled: boolean
  fallbackModel?: string | FallbackModelObject
  cooldownMs: number
  patterns: string[]
  logging: boolean
  logFile?: string
  resumeText: string
}

export interface LoadResult {
  config: RateLimitFallbackConfig
  sources: string[]
  warnings: string[]
}

export interface LoadOptions {
  /** Override the config file search order. Tests pass an empty array. */
  paths?: string[]
}

export const DEFAULT_PATTERNS: readonly string[] = [
  "rate limit",
  "rate_limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
  "capacity exceeded",
]

export const DEFAULT_RESUME_TEXT =
  "The previous model hit a rate limit. Continue the last user request with the fallback model."

const DEFAULTS: RateLimitFallbackConfig = {
  enabled: true,
  cooldownMs: 300_000,
  patterns: [...DEFAULT_PATTERNS],
  logging: false,
  resumeText: DEFAULT_RESUME_TEXT,
}

export function defaultConfigPaths(): string[] {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config")
  const base = join(configHome, "opencode")
  return [base, join(base, "config"), join(base, "plugins"), join(base, "plugin")].map((directory) =>
    join(directory, "rate-limit-fallback.json"),
  )
}

export function normalizeFallbackModel(value: unknown): string | FallbackModelObject | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (!isRecord(value)) return undefined

  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : ""
  const id =
    typeof value.id === "string"
      ? value.id.trim()
      : typeof value.modelID === "string"
        ? value.modelID.trim()
        : ""
  if (!providerID || !id) return undefined

  const variant = typeof value.variant === "string" && value.variant.trim() ? value.variant.trim() : undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

export function mergeConfig(
  base: RateLimitFallbackConfig,
  raw: unknown,
  warnings: string[],
  source: string,
): RateLimitFallbackConfig {
  if (!isRecord(raw)) {
    warnings.push(`Ignoring ${source}: expected a JSON object.`)
    return base
  }

  const next: RateLimitFallbackConfig = { ...base, patterns: [...base.patterns] }

  if ("enabled" in raw) {
    if (typeof raw.enabled === "boolean") next.enabled = raw.enabled
    else warnings.push(`Ignoring ${source}: "enabled" must be a boolean.`)
  }

  if ("fallbackModel" in raw) {
    const model = normalizeFallbackModel(raw.fallbackModel)
    if (model) {
      next.fallbackModel = model
    } else {
      next.fallbackModel = undefined
      warnings.push(`Ignoring ${source}: "fallbackModel" must be "provider/model" or an object with providerID and id.`)
    }
  }

  if ("cooldownMs" in raw) {
    const value = raw.cooldownMs
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) next.cooldownMs = Math.floor(value)
    else warnings.push(`Ignoring ${source}: "cooldownMs" must be a non-negative number.`)
  }

  if ("patterns" in raw) {
    const value = raw.patterns
    if (Array.isArray(value)) {
      const patterns = value
        .filter((pattern): pattern is string => typeof pattern === "string" && pattern.trim().length > 0)
        .map((pattern) => pattern.trim())
      if (patterns.length > 0) next.patterns = patterns
      else warnings.push(`Ignoring ${source}: "patterns" must contain at least one non-empty string.`)
    } else {
      warnings.push(`Ignoring ${source}: "patterns" must be an array of strings.`)
    }
  }

  if ("logging" in raw) {
    if (typeof raw.logging === "boolean") next.logging = raw.logging
    else warnings.push(`Ignoring ${source}: "logging" must be a boolean.`)
  }

  if ("logFile" in raw) {
    if (typeof raw.logFile === "string" && raw.logFile.trim()) next.logFile = raw.logFile.trim()
    else warnings.push(`Ignoring ${source}: "logFile" must be a non-empty string.`)
  }

  if ("resumeText" in raw) {
    if (typeof raw.resumeText === "string" && raw.resumeText.trim()) next.resumeText = raw.resumeText.trim()
    else warnings.push(`Ignoring ${source}: "resumeText" must be a non-empty string.`)
  }

  return next
}

export async function loadConfig(options: unknown = {}, loadOptions: LoadOptions = {}): Promise<LoadResult> {
  const warnings: string[] = []
  const sources: string[] = []
  let config: RateLimitFallbackConfig = { ...DEFAULTS, patterns: [...DEFAULTS.patterns] }

  const paths = loadOptions.paths ?? defaultConfigPaths()
  for (const path of paths) {
    try {
      const text = await readFile(path, "utf8")
      const parsed: unknown = JSON.parse(text)
      config = mergeConfig(config, parsed, warnings, path)
      sources.push(path)
      break
    } catch (error) {
      if (isMissingFile(error)) continue
      warnings.push(`Could not load ${path}: ${errorMessage(error)}`)
    }
  }

  if (isRecord(options) && Object.keys(options).length > 0) {
    config = mergeConfig(config, options, warnings, "plugin options")
    sources.push("plugin options")
  }

  if (config.enabled && !config.fallbackModel) {
    warnings.push("No fallbackModel configured. The plugin stays inactive until one is set.")
  }

  return { config, sources, warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
