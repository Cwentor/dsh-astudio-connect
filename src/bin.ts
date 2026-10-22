#!/usr/bin/env node
/**
 * AStudio Connect CLI: secret-free status, doctor, and logout.
 *
 * The CLI is boot-free: it never reads the token into a shell prompt or writes
 * the AStudio config.toml. `logout` clears only the plugin's in-memory cache.
 *
 * Hints: `doctor` reports config path/existence, sign-in state, whether the
 * model-manager token is present, and repair hints (exit 0 only when signed in
 * and the config file exists); `status` also reports catalog source and model
 * count. Neither prints the token — only `tokenLength` and presence — and
 * JWT-shaped strings in error output are replaced with `[redacted token]`.
 * `status` always claims the "built-in" catalog source, because the live
 * refresh only happens inside the host process; the settings card shows the
 * host's real source instead.
 *
 * @module dsh-astudio-connect/bin
 */

import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAStudioAuth } from './auth.ts'
import { createAStudioCatalog } from './catalog.ts'

type Action = 'doctor' | 'logout' | 'status'

/** The only provider this bundle serves. */
const ASTRO_PROVIDER = 'astudio'

/** Options shared by the run entry point and its command handlers. */
export interface RunOptions {
  /** Override the AStudio config.toml path (used by tests). */
  configPath?: string
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-astudio-connect <doctor|status|logout> [--provider astudio] [--json]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state, catalog source, and model count',
    '  logout   clear the plugin in-memory credential cache',
    '',
    '  --provider  which provider to inspect; defaults to astudio',
    `              one of: ${ASTRO_PROVIDER}`,
    '  --json      emit one secret-free JSON document (doctor/status only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function makeStore(options: RunOptions = {}) {
  return createAStudioAuth(options.configPath !== undefined ? { configPath: options.configPath } : {})
}

function makeCatalog(store: ReturnType<typeof makeStore>) {
  return createAStudioCatalog({
    upstream: { chat: async () => { throw new Error('not used') } },
    token: () => store.resolve(),
    modelBearerToken: () => store.modelBearerToken(),
  })
}

async function doctor(jsonOutput: boolean, options: RunOptions): Promise<number> {
  const store = makeStore(options)
  const status = await store.status()
  const configPresent = existsSync(status.configPath)
  const report = {
    schemaVersion: 1,
    package: 'dsh-astudio-connect',
    provider: ASTRO_PROVIDER,
    signIn: status.state,
    configFile: {
      path: status.configPath,
      present: configPresent,
    },
    modelCatalog: {
      // Without this token the plugin still works, but it serves the built-in
      // roster instead of the live document, so the doctor names it.
      hasModelToken: status.hasModelToken === true,
    },
    hints: [
      ...status.state === 'signed-out' ? ['Sign in once in the AStudio desktop app, then run status again.'] : [],
      ...configPresent ? [] : [`No AStudio config.toml at ${status.configPath}.`],
      ...status.hints,
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `AStudio Connect on ${process.version}`,
      `Config file: ${configPresent ? 'present' : 'missing'} — ${status.configPath}`,
      `Sign-in state: ${report.signIn}`,
      `Model catalog token: ${report.modelCatalog.hasModelToken ? 'present' : 'missing (built-in roster)'}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'signed-in' && configPresent ? 0 : 1
}

async function status(jsonOutput: boolean, options: RunOptions): Promise<number> {
  const store = makeStore(options)
  const authStatus = await store.status()
  const catalog = makeCatalog(store)
  const report = {
    schemaVersion: 1,
    package: 'dsh-astudio-connect',
    provider: ASTRO_PROVIDER,
    state: authStatus.state,
    source: catalog.source(),
    modelCount: catalog.current().length,
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `AStudio Connect: ${report.state}`,
      `Catalog source: ${report.source}`,
      `Models: ${report.modelCount}`,
      '',
    ].join('\n'))
  }
  return authStatus.state === 'signed-in' ? 0 : 1
}

/** Execute one boot-free command; returns the process exit code. */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-astudio-connect: expected doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')

  let providerId: string | undefined
  const rest: string[] = []
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index]!
    if (flag === '--provider') {
      providerId = flags[index + 1]
      index += 1
      continue
    }
    if (flag.startsWith('--provider=')) {
      providerId = flag.slice('--provider='.length)
      continue
    }
    rest.push(flag)
  }
  if (providerId === undefined) providerId = ASTRO_PROVIDER
  if (providerId !== ASTRO_PROVIDER) {
    process.stderr.write(`dsh-astudio-connect: unknown provider ${JSON.stringify(providerId)}; expected ${ASTRO_PROVIDER}\n`)
    return 1
  }
  const unknown = rest.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-astudio-connect: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }

  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput, options)
      case 'status':
        return await status(jsonOutput, options)
      case 'logout': {
        const store = makeStore(options)
        await store.logout()
        process.stdout.write('AStudio Connect: credential cache cleared\n')
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-astudio-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
