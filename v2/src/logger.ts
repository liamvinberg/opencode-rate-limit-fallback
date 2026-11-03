import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type LogLevel = "INFO" | "WARN" | "ERROR"

export type Logger = ((
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>,
) => Promise<void>) & { readonly file: string }

const createdDirectories = new Set<string>()

export function defaultLogFile(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
  return join(dataHome, "opencode", "log", "rate-limit-fallback.log")
}

export function createLogger(enabled: boolean, file?: string): Logger {
  const target = file?.trim() || defaultLogFile()

  const write = async (level: LogLevel, message: string, data?: Record<string, unknown>): Promise<void> => {
    if (!enabled) return

    const suffix = data ? ` ${JSON.stringify(data)}` : ""
    const line = `${new Date().toISOString()} ${level} ${message}${suffix}\n`

    try {
      const directory = dirname(target)
      if (!createdDirectories.has(directory)) {
        await mkdir(directory, { recursive: true })
        createdDirectories.add(directory)
      }
      await appendFile(target, line, "utf8")
    } catch {
      // Logging is best effort and must never break a session.
    }
  }

  return Object.assign(write, { file: target })
}
