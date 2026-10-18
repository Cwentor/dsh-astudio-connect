/**
 * Local identity for AStudio Connect.
 *
 * AStudio's config token does not carry a stable user id, so per-account
 * catalog, visibility, and probe persistence collapses to one local identity.
 *
 * @module dsh-astudio-connect/identity
 */

/** Stable local identity used by all AStudio Connect persistence. */
export const ASTRO_LOCAL_IDENTITY = 'astudio-local'

/** Resolve the local identity used by catalog, visibility, and probe stores. */
export function localIdentity(): string {
  return ASTRO_LOCAL_IDENTITY
}
