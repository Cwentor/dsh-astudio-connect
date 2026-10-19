/**
 * Status document validation for the browser half.
 *
 * The status route never sends a partial document: every field it declares is
 * always present. The validator therefore only has to rule out a body that is
 * not an AStudio status document at all — a non-object, a different document
 * shape, or a signed-out payload with a wrong state — before the card dereferences
 * its sections.
 *
 * @module dsh-astudio-connect/client/status-document
 */

import type { AStudioWebStatus } from '../status-paths.ts'

/**
 * Narrow an unknown JSON value to {@link AStudioWebStatus}.
 *
 * Deliberately shallow: it checks the document is an object with the four
 * required sections and a valid sign-in state. It does not validate every
 * nested member, so a malformed leaf surfaces as a render-time `undefined`
 * rather than an inverted verdict — the host owns the document shape.
 */
export function isAStudioWebStatus(value: unknown): value is AStudioWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.auth !== 'object' || v.auth === null || Array.isArray(v.auth)) return false
  if (typeof v.catalog !== 'object' || v.catalog === null || Array.isArray(v.catalog)) return false
  if (typeof v.visibility !== 'object' || v.visibility === null || Array.isArray(v.visibility)) return false
  if (typeof v.probe !== 'object' || v.probe === null || Array.isArray(v.probe)) return false
  const auth = v.auth as Record<string, unknown>
  if (auth.state !== 'signed-in' && auth.state !== 'signed-out') return false
  return true
}
