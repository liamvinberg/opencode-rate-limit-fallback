# opencode-rate-limit-fallback (OpenCode V2)

OpenCode **V2** implementation of the rate-limit fallback plugin. The root of this repository targets the V1 plugin API; OpenCode V2 uses a different plugin shape and cannot load the V1 entrypoint.

On a rate limit the plugin switches the session to a fallback model and retries the request, so the prompt does not have to be sent again:

```
provider 429  ->  switchModel(fallback)  ->  retry immediately  ->  answer from the fallback
```

## Requirements

- OpenCode `>= 2.2.5`
- Node.js `>= 20`

## Install

```bash
npm install opencode-rate-limit-fallback-v2
```

Register it in `opencode.json` / `opencode.jsonc` (global or per project):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-rate-limit-fallback-v2",
      "options": {
        "fallbackModel": "anthropic/claude-sonnet-4-5"
      }
    }
  ]
}
```

A local checkout works too:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-rate-limit-fallback/v2",
      "options": { "fallbackModel": "anthropic/claude-sonnet-4-5", "logging": true }
    }
  ]
}
```

`fallbackModel` uses the same `provider/model` syntax as `opencode models` and accepts an optional `#variant` suffix. The plugin has no runtime dependency on `@opencode/plugin`; the package is used only for TypeScript types.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Set to `false` to keep the entry but disable the behavior. |
| `fallbackModel` | `string \| { providerID, id, variant? }` | — | Model to switch to. Required; without it the plugin stays inactive. |
| `cooldownMs` | `number` | `300000` | How long a session stays on its fallback before another 429 can trigger a new switch. |
| `patterns` | `string[]` | see below | Case-insensitive substrings matched against the error type and message. Replaces the defaults. |
| `logging` | `boolean` | `false` | Write diagnostics to the plugin log file. |
| `logFile` | `string` | `<data>/opencode/log/rate-limit-fallback.log` | Override the log path. |
| `resumeText` | `string` | see below | Message used when the plugin has to resume a session explicitly. |

Default patterns:

```json
[
  "rate limit",
  "rate_limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "overloaded",
  "capacity exceeded"
]
```

HTTP `429` and `529` are always treated as rate limits, even when no pattern matches.

### Config file fallback

For compatibility with existing V1 setups, options can also live in a JSON file. The first existing file wins:

```
$XDG_CONFIG_HOME/opencode/rate-limit-fallback.json
$XDG_CONFIG_HOME/opencode/config/rate-limit-fallback.json
$XDG_CONFIG_HOME/opencode/plugins/rate-limit-fallback.json
$XDG_CONFIG_HOME/opencode/plugin/rate-limit-fallback.json
```

`XDG_CONFIG_HOME` defaults to `~/.config`. Values from `plugins[].options` override the file.

```json
{
  "fallbackModel": "anthropic/claude-sonnet-4-5",
  "cooldownMs": 300000,
  "logging": true
}
```

## How it works

1. OpenCode calls the `session.retry` hook after a provider request fails.
2. The plugin checks the status (`429` / `529`) and the configured patterns.
3. On a rate limit it calls `session.switchModel({ sessionID, model: fallback })` and sets `decision = { retry: true, delay: 0 }`. OpenCode retries the same request on the fallback model, so the user never sees an error in the normal case.
4. If the immediate retry still reports the old model, the plugin vetoes that retry and resumes the session with a synthetic message after the session becomes idle. This path can surface the original error once, but the conversation continues on the fallback.
5. If the fallback model is rate-limited too, the plugin leaves OpenCode's decision unchanged instead of switching in a loop.
6. State is kept per session and removed on `session.deleted`. After `cooldownMs`, a new rate limit can switch the session again.

The plugin never switches when the failing model already is the configured fallback.

## Logs

With `logging: true`, lines are appended to:

```
$XDG_DATA_HOME/opencode/log/rate-limit-fallback.log
```

`XDG_DATA_HOME` defaults to `~/.local/share`. Logging is best effort; an unwritable log file never breaks a session.

## Development

```bash
cd v2
npm install
npm test        # builds, then runs config, detection and plugin tests
npm run build
npm run typecheck
```

The test suite uses Node's built-in test runner and needs neither network nor GPU.

## Publishing

This directory is a separate package so the V1 entrypoint at the repository root keeps working. It is published independently:

```bash
cd v2
npm publish
```

`prepublishOnly` runs the full test suite.

## License

MIT
