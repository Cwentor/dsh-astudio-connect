/**
 * Confirm the pi-ai copy this plugin actually loaded is the generation its own
 * `package.json` pins.
 *
 * #92's failure mode: a pnpm profile with `nodeLinker: hoisted` and
 * `autoInstallPeers: false` installs no peer for us, so a co-installed
 * plugin's older pi-ai sits at the profile root and wins bare-specifier
 * resolution. The host then adds a system message (pi-ai 0.87's
 * `collapseSystemMessages`) and the older copy answers `estimateMessageTokens`
 * by reading `.length` off a block it does not model — every request dies at
 * `PI_AI_ERROR` before any upstream HTTP. Declaring pi-ai as a regular
 * dependency (package.json) is the fix; this module exists so a future
 * regression reports *what* it loaded instead of that opaque crash.
 *
 * The dependency is a range (`^1.1.0`), not a pin, so "the right copy" is a
 * generation rather than one string: any 1.x at or above the floor is
 * accepted, and the warning names the floor. Pinning the guard to an exact
 * version would flag every healthy install the moment npm resolved a newer
 * patch.
 *
 * It is deliberately a warning, not a throw. The plugin is mid-load at this
 * point, and a hard failure here would take down a host that may still be able
 * to serve other providers. The message is the product; the operator decides.
 *
 * The DSH host version is named nowhere here on purpose. It changes on the
 * host's release cadence, while this guard is about the pi-ai generation alone;
 * an earlier revision named the host and its value then went stale — it kept
 * claiming a host generation that package.json had already moved past.
 *
 * @module dsh-astudio-connect/pi-ai-guard
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The pi-ai major generation this plugin is built and tested against. */
export const REQUIRED_PI_AI_MAJOR = 1

/**
 * Oldest pi-ai release in that generation this plugin accepts.
 *
 * DSH 0.2.1 moved `dsh-llm-pi-ai` from pi-ai `^0.87.1` to `^1.1.0`; that
 * adapter and this plugin now share the 1.x model vocabulary (`BaseModel`,
 * `getAllModels`, image-request targets). A 1.0.x copy is the same generator
 * but predates what the 0.2.1 host adapter was written for, so it is reported
 * rather than trusted.
 */
export const REQUIRED_PI_AI_VERSION = '1.1.0'

/** Numeric `major.minor.patch` of a version, ignoring any prerelease tail. */
function versionParts(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim())
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * Whether a resolved pi-ai version belongs to the accepted generation and is
 * at least {@link REQUIRED_PI_AI_VERSION}.
 *
 * A caret range cannot be compared against a concrete version without semver
 * resolution, and this runs before any dependency is importable, so the check
 * is written out: same major, not older than the required one. An unparsable
 * version is *not* accepted — that is the shape a vendored or renamed copy
 * takes, and silence there is what #92 cost.
 */
export function piAiVersionAccepted(version: string): boolean {
  const parts = versionParts(version)
  if (parts === undefined) return false
  const [major, minor, patch] = parts
  if (major !== REQUIRED_PI_AI_MAJOR) return false
  const required = versionParts(REQUIRED_PI_AI_VERSION)
  if (required === undefined) return false
  const [, requiredMinor, requiredPatch] = required
  return minor > requiredMinor || (minor === requiredMinor && patch >= requiredPatch)
}

/**
 * Read the version of the pi-ai copy Node resolves for *this* module.
 *
 * The package's exports map does not open `./package.json`, so the manifest
 * cannot be imported. Instead the module's own specifier is resolved and the
 * resulting file is walked up to the directory whose `package.json` names
 * `@earendil-works/pi-ai`. That reads the copy actually loaded rather than a
 * guess from the install tree.
 *
 * @returns The resolved version, or undefined when it cannot be determined.
 */
export function resolvedPiAiVersion(): string | undefined {
  let entry: string
  try {
    entry = import.meta.resolve('@earendil-works/pi-ai')
  } catch {
    return undefined
  }
  let dir = dirname(fileURLToPath(entry))
  // The entry sits at <package>/dist/index.js, so the manifest is one or two
  // levels up; a few extra steps keep this working if that layout shifts.
  for (let step = 0; step < 5; step += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (manifest.name === '@earendil-works/pi-ai' && typeof manifest.version === 'string') {
        return manifest.version
      }
    } catch {
      // No manifest here, or not readable: keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * One line describing a pi-ai copy outside the required generation, or
 * undefined when the resolved version is accepted or cannot be read.
 *
 * The cause is left open on purpose. A hoisted profile root is the case #92
 * measured, but an updater or installer can just as easily leave the wrong copy
 * in place, and this diagnostic cannot tell them apart from a version string.
 * Naming the loaded version, the accepted generation and the remedy is what the
 * reader can act on; naming only versions and the fix also keeps any filesystem
 * path out of logs and reports.
 *
 * Carries no plugin prefix: callers log it under their own.
 *
 * @param resolved - Version to report on. Read from the live module graph when
 * omitted; pass it explicitly to describe a hypothetical copy.
 */
export function piAiVersionWarning(resolved?: string | undefined): string | undefined {
  const version = arguments.length === 0 ? resolvedPiAiVersion() : resolved
  if (version === undefined || piAiVersionAccepted(version)) return undefined
  return `loaded @earendil-works/pi-ai ${version}, but this plugin is built for `
    + `${REQUIRED_PI_AI_VERSION} or newer in the ${REQUIRED_PI_AI_MAJOR}.x generation. `
    + 'The wrong copy is being resolved — check the '
    + 'profile\'s pi-ai install (a pnpm profile with nodeLinker "hoisted" and '
    + `autoInstallPeers false can expose another package's older copy). Reinstalling the `
    + `plugin so it installs its own ${REQUIRED_PI_AI_VERSION}+ copy resolves it`
}
