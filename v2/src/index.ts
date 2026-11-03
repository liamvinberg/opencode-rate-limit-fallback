import type { Plugin } from "@opencode/plugin"
import { loadConfig, type RateLimitFallbackConfig } from "./config.js"
import { isRateLimitFailure, parseModelRef, sameModel, type ModelRef } from "./detect.js"
import { createLogger, type Logger } from "./logger.js"

export const PLUGIN_ID = "opencode-rate-limit-fallback"

const IDLE_WAIT_MS = 10_000

interface SessionState {
  switchedAt: number
  resumed: boolean
  switching: boolean
}

const plugin = {
  id: PLUGIN_ID,
  async setup(ctx: Plugin.Context) {
    const { config, sources, warnings } = await loadConfig(ctx.options)
    const log = createLogger(config.logging, config.logFile)

    for (const warning of warnings) await log("WARN", warning)

    if (!config.enabled) {
      await log("INFO", "plugin disabled by configuration")
      return
    }

    const fallback = config.fallbackModel ? parseModelRef(config.fallbackModel) : undefined
    if (!fallback) {
      await log("WARN", "no valid fallbackModel configured; plugin inactive")
      return
    }

    const states = new Map<string, SessionState>()

    const resume = async (sessionID: string): Promise<void> => {
      try {
        await waitForIdle(ctx, sessionID, IDLE_WAIT_MS)
        const info = await ctx.session.get({ sessionID })
        if (info.outcome === "succeeded" || info.outcome === "interrupted") {
          await log("INFO", "skipping fallback resume; session already settled", {
            sessionID,
            outcome: info.outcome,
          })
          return
        }
        await ctx.session.synthetic({ sessionID, text: config.resumeText, resume: true })
        await log("INFO", "resumed session with fallback model", { sessionID })
      } catch (error) {
        await log("ERROR", "failed to resume session", {
          sessionID,
          error: errorMessage(error),
        })
      }
    }

    await ctx.session.hook("retry", async (event) => {
      if (!isRateLimitFailure(event.error, config.patterns)) return

      const sessionID = event.sessionID
      const state = states.get(sessionID)
      const now = Date.now()

      if (state?.switching) return

      if (state && now - state.switchedAt < config.cooldownMs) {
        if (sameModel(event.model, fallback)) {
          void log("WARN", "fallback model is rate limited too; leaving retry decision unchanged", {
            sessionID,
            model: formatModel(fallback),
          })
          return
        }

        if (!state.resumed) {
          // The retry kept the captured model. Stop retrying and continue explicitly.
          event.decision = { retry: false }
          state.resumed = true
          void log("WARN", "retry kept the original model; resuming with fallback", {
            sessionID,
            model: formatModel(event.model),
          })
          void resume(sessionID)
          return
        }

        return
      }

      if (sameModel(event.model, fallback)) {
        void log("WARN", "fallback model is rate limited too; leaving retry decision unchanged", {
          sessionID,
          model: formatModel(fallback),
        })
        return
      }

      const nextState: SessionState = {
        switchedAt: now,
        resumed: false,
        switching: true,
      }
      states.set(sessionID, nextState)

      try {
        await ctx.session.switchModel({ sessionID, model: fallback })
        nextState.switching = false
        event.decision = { retry: true, delay: 0 }
        await log("INFO", "switched to fallback model; retrying request", {
          sessionID,
          from: formatModel(event.model),
          model: formatModel(fallback),
          attempt: event.attempt,
          status: event.error.status,
        })
      } catch (error) {
        nextState.switching = false
        states.delete(sessionID)
        event.decision = { retry: false }
        await log("ERROR", "failed to switch to fallback model", {
          sessionID,
          error: errorMessage(error),
        })
      }
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.deleted"],
          signal: controller.signal,
        })) {
          if (event.type === "session.deleted") states.delete(event.data.sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          await log("WARN", "event subscription stopped", { error: errorMessage(error) })
        }
      }
    })()

    await log("INFO", "plugin ready", {
      fallbackModel: formatModel(fallback),
      cooldownMs: config.cooldownMs,
      sources,
    })

    return () => controller.abort()
  },
} satisfies Plugin.Plugin

export default plugin

async function waitForIdle(ctx: Plugin.Context, sessionID: string, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ctx.session.wait({ sessionID }).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
