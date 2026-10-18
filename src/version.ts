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

/** Current package version. */
export const ASTRO_VERSION = '0.1.0'

/** Repository URL reported by the update route. */
export const ASTRO_REPOSITORY_URL = 'https://github.com/astudio-connect/dsh-astudio-connect'
