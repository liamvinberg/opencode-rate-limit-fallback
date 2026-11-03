import type { FallbackModelObject } from "./config.js"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface FailureLike {
  status?: number
  message?: string
  type?: string
}

export function parseModelRef(value: string | FallbackModelObject): ModelRef | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    const slash = trimmed.indexOf("/")
    if (slash <= 0 || slash === trimmed.length - 1) return undefined

    const providerID = trimmed.slice(0, slash).trim()
    let rest = trimmed.slice(slash + 1).trim()
    let variant: string | undefined

    const hash = rest.lastIndexOf("#")
    if (hash > 0 && hash < rest.length - 1) {
      variant = rest.slice(hash + 1).trim()
      rest = rest.slice(0, hash).trim()
    }

    if (!providerID || !rest) return undefined
    return variant ? { providerID, id: rest, variant } : { providerID, id: rest }
  }

  const providerID = value.providerID.trim()
  const id = (value.id ?? value.modelID ?? "").trim()
  if (!providerID || !id) return undefined

  const variant = value.variant?.trim()
  return variant ? { providerID, id, variant } : { providerID, id }
}

export function isRateLimitFailure(failure: FailureLike, patterns: readonly string[]): boolean {
  if (failure.status === 429 || failure.status === 529) return true

  const haystack = `${failure.type ?? ""}\n${failure.message ?? ""}`.toLowerCase()
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase()
    return needle.length > 0 && haystack.includes(needle)
  })
}

export function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.id === right.id
}
