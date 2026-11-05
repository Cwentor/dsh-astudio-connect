/**
 * Package identity reported by the update route.
 *
 * Keeping the version here keeps the route's public document self-contained
 * while the single source of truth remains the package.json `version` field.
 *
 * @module dsh-astudio-connect/version
 */

/** Package name reported by the update route. */
export const ASTRO_PACKAGE_NAME = 'dsh-astudio-connect'

/**
 * Current package version.
 *
 * Kept in step with `package.json` by hand — the release commit is what bumps
 * both. It drifted to `0.1.0` for three releases while the packages shipped as
 * `0.2.0`–`0.2.2`, which made the update route and the heartbeat advertise a
 * version that no longer existed.
 */
export const ASTRO_VERSION = '0.2.4'

/**
 * Repository URL reported by the update route.
 *
 * Must agree with package.json's `repository.url`: the update route builds both
 * its releases API URL and its release-page links from here, so a stale org
 * name makes every GitHub enrichment 404 while the npm judgement still reports
 * an update — a silent failure that looks like "no release notes available".
 * tests/update.spec.ts asserts the literal.
 */
export const ASTRO_REPOSITORY_URL = 'https://github.com/Cwentor/dsh-astudio-connect'
