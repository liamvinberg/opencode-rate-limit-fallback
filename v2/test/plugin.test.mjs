import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const configHome = await mkdtemp(join(tmpdir(), "rlf-plugin-"))
process.env.XDG_CONFIG_HOME = join(configHome, "config")
process.env.XDG_DATA_HOME = join(configHome, "data")

const { default: plugin, PLUGIN_ID } = await import("../dist/index.js")

test.after(async () => {
  await rm(configHome, { recursive: true, force: true })
})

function createContext(options, { outcome = "failed" } = {}) {
  const hooks = new Map()
  const calls = {
    switchModel: [],
    synthetic: [],
    wait: 0,
    get: [],
    subscriptions: 0,
    signal: undefined,
  }

  const ctx = {
    options,
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback)
        return { dispose: async () => {} }
      },
      wait: async (input) => {
        calls.wait += 1
        calls.waitInput = input
      },
      get: async (input) => {
        calls.get.push(input)
        return { outcome, time: {} }
      },
      switchModel: async (input) => {
        calls.switchModel.push(input)
      },
      synthetic: async (input) => {
        calls.synthetic.push(input)
      },
    },
    event: {
      subscribe: ({ signal }) => {
        calls.subscriptions += 1
        calls.signal = signal
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener("abort", resolve, { once: true })
            })
          },
        }
      },
    },
  }

  return { ctx, hooks, calls }
}

function retryEvent(overrides = {}) {
  return {
    sessionID: "session-1",
    agent: "build",
    model: { providerID: "acme", id: "primary" },
    error: { type: "provider.request", message: "Too many requests", status: 429 },
    attempt: 1,
    decision: { retry: true, delay: 1_000 },
    ...overrides,
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition was not met in time")
}

const baseOptions = {
  fallbackModel: "acme/fallback",
  cooldownMs: 60_000,
  patterns: ["rate limit"],
  logging: false,
}

const fallbackModel = { providerID: "acme", id: "fallback" }

test("the plugin exposes a stable id and a setup function", () => {
  assert.equal(PLUGIN_ID, "opencode-rate-limit-fallback")
  assert.equal(plugin.id, "opencode-rate-limit-fallback")
  assert.equal(typeof plugin.setup, "function")
})

test("a rate limit switches the model and retries without an error", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    const event = retryEvent()
    await hooks.get("retry")(event)

    assert.deepEqual(event.decision, { retry: true, delay: 0 })
    assert.deepEqual(calls.switchModel, [{ sessionID: "session-1", model: fallbackModel }])
    assert.equal(calls.synthetic.length, 0)
    assert.equal(calls.wait, 0)
  } finally {
    cleanup()
  }
})

test("a failure on the fallback model leaves the retry decision alone", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    const event = retryEvent({ model: fallbackModel })
    await hooks.get("retry")(event)

    assert.deepEqual(event.decision, { retry: true, delay: 1_000 })
    assert.equal(calls.switchModel.length, 0)
    assert.equal(calls.synthetic.length, 0)
  } finally {
    cleanup()
  }
})

test("a repeated rate limit on the original model vetoes the retry and resumes with the fallback", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    await hooks.get("retry")(retryEvent())

    const second = retryEvent({ attempt: 2 })
    await hooks.get("retry")(second)

    assert.deepEqual(second.decision, { retry: false })
    await waitFor(() => calls.synthetic.length === 1)

    assert.equal(calls.wait, 1)
    assert.deepEqual(calls.waitInput, { sessionID: "session-1" })
    assert.equal(calls.switchModel.length, 1)
    assert.deepEqual(calls.synthetic, [
      {
        sessionID: "session-1",
        text: "The previous model hit a rate limit. Continue the last user request with the fallback model.",
        resume: true,
      },
    ])
  } finally {
    cleanup()
  }
})

test("a repeated rate limit on the fallback model is left alone", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    await hooks.get("retry")(retryEvent())

    const second = retryEvent({ attempt: 2, model: fallbackModel })
    await hooks.get("retry")(second)

    assert.deepEqual(second.decision, { retry: true, delay: 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(calls.switchModel.length, 1)
    assert.equal(calls.synthetic.length, 0)
  } finally {
    cleanup()
  }
})

test("the resume happens only once per switched session", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    await hooks.get("retry")(retryEvent())
    const second = retryEvent({ attempt: 2 })
    await hooks.get("retry")(second)
    await waitFor(() => calls.synthetic.length === 1)

    const third = retryEvent({ attempt: 3 })
    await hooks.get("retry")(third)

    assert.deepEqual(third.decision, { retry: true, delay: 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(calls.synthetic.length, 1)
  } finally {
    cleanup()
  }
})

test("a session that already settled is not resumed", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions, { outcome: "succeeded" })
  const cleanup = await plugin.setup(ctx)
  try {
    await hooks.get("retry")(retryEvent())
    const second = retryEvent({ attempt: 2 })
    await hooks.get("retry")(second)

    assert.deepEqual(second.decision, { retry: false })
    await waitFor(() => calls.get.length === 1)
    assert.equal(calls.synthetic.length, 0)
  } finally {
    cleanup()
  }
})

test("unrelated failures are ignored", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    const event = retryEvent({
      error: { type: "provider.request", message: "invalid request", status: 400 },
      decision: { retry: false },
    })
    await hooks.get("retry")(event)

    assert.deepEqual(event.decision, { retry: false })
    assert.equal(calls.switchModel.length, 0)
    assert.equal(calls.synthetic.length, 0)
  } finally {
    cleanup()
  }
})

test("concurrent rate limit events start only one fallback", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  try {
    const first = retryEvent()
    const pending = hooks.get("retry")(first)

    const second = retryEvent({ attempt: 2 })
    await hooks.get("retry")(second)

    assert.deepEqual(second.decision, { retry: true, delay: 1_000 })
    assert.equal(calls.switchModel.length, 1)

    await pending
    assert.deepEqual(first.decision, { retry: true, delay: 0 })
    assert.equal(calls.switchModel.length, 1)
  } finally {
    cleanup()
  }
})

test("a new rate limit after the cooldown switches again", async () => {
  const { ctx, hooks, calls } = createContext({ ...baseOptions, cooldownMs: 0 })
  const cleanup = await plugin.setup(ctx)
  try {
    await hooks.get("retry")(retryEvent())
    const second = retryEvent({ attempt: 2 })
    await hooks.get("retry")(second)

    assert.deepEqual(second.decision, { retry: true, delay: 0 })
    assert.equal(calls.switchModel.length, 2)
    assert.equal(calls.synthetic.length, 0)
  } finally {
    cleanup()
  }
})

test("a failing model switch does not retry", async () => {
  const { ctx, hooks, calls } = createContext(baseOptions)
  ctx.session.switchModel = async () => {
    throw new Error("model unavailable")
  }
  const cleanup = await plugin.setup(ctx)
  try {
    const event = retryEvent()
    await hooks.get("retry")(event)

    assert.deepEqual(event.decision, { retry: false })
    assert.equal(calls.synthetic.length, 0)
  } finally {
    cleanup()
  }
})

test("cleanup aborts the event subscription", async () => {
  const { ctx, calls } = createContext(baseOptions)
  const cleanup = await plugin.setup(ctx)
  await waitFor(() => calls.subscriptions === 1)

  assert.equal(calls.signal.aborted, false)
  cleanup()
  assert.equal(calls.signal.aborted, true)
})

test("a missing fallback model keeps the plugin inactive", async () => {
  const { ctx, hooks, calls } = createContext({ ...baseOptions, fallbackModel: "" })
  const cleanup = await plugin.setup(ctx)

  assert.equal(hooks.size, 0)
  assert.equal(calls.subscriptions, 0)
  assert.equal(cleanup, undefined)
})
