/**
 * AStudio catalog persistence. One file under the DSH home keeps the last
 * successful model snapshot per identity, so a restart or a failed fetch can
 * serve the account's last real roster. There is no compiled-in roster behind
 * this file: when no snapshot exists, the catalog is empty.
 *
 * Snapshots are versioned because this file has changed meaning. Version 1 was
 * written by builds that merged a compiled-in roster into the snapshot, so a
 * row in it cannot be told apart from a row upstream actually returned — that
 * data is exactly what the current build must not trust, and version 1 files
 * are discarded rather than migrated.
 *
 * @module dsh-astudio-connect/catalog-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { AStudioModelInfo } from './catalog.ts'

/** Filename for the catalog snapshot file inside the DSH home. */
export const ASTRO_CATALOG_FILENAME = '.astudio-connect/catalog.json'

/** On-disk document shape; readers reject other versions. */
export interface AStudioCatalogFile {
  /**
   * 2 — every row came from an upstream answer.
   * 1 — rows may have come from the old compiled-in roster (not accepted).
   */
  version: 2
  catalogs: Record<string, AStudioCatalogSnapshot>
}

/** One identity's saved catalog. */
export interface AStudioCatalogSnapshot {
  fetchedAtMs: number
  models: AStudioModelInfo[]
}

/** File path for the catalog snapshot file. */
export function astudioCatalogPath(): string {
  return join(resolveDshHome(), ASTRO_CATALOG_FILENAME)
}

/**
 * Read the document, treating anything unreadable as absent.
 *
 * A corrupt file must not stop the catalog from being rewritten, and must not
 * be carried forward into the next write.
 */
async function readDocument(path: string): Promise<Partial<AStudioCatalogFile>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Partial<AStudioCatalogFile> : {}
  } catch {
    return {}
  }
}

/** Read a snapshot for one identity, or undefined when none is saved. */
export async function readCatalogSnapshot(path: string, identity: string): Promise<AStudioCatalogSnapshot | undefined> {
  const file = await readDocument(path)
  if (file.version !== 2) return undefined
  const snapshot = file.catalogs?.[identity]
  if (snapshot === undefined) return undefined
  if (!Array.isArray(snapshot.models)) return undefined
  return snapshot
}

/** Write a snapshot for one identity with a sibling temp file plus rename. */
export async function writeCatalogSnapshot(path: string, identity: string, models: readonly AStudioModelInfo[], fetchedAtMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const parsed = await readDocument(path)
  // Only a same-version document carries data worth keeping; a version 1 file
  // holds rows of unknown provenance and is dropped in full.
  const catalogs = parsed.version === 2 ? parsed.catalogs ?? {} : {}
  const next: AStudioCatalogFile = {
    version: 2,
    catalogs: {
      ...catalogs,
      [identity]: { fetchedAtMs, models: [...models] },
    },
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Remove one identity's snapshot. */
export async function deleteCatalogSnapshot(path: string, identity: string): Promise<void> {
  const parsed = await readDocument(path)
  const catalogs = { ...(parsed.version === 2 ? parsed.catalogs ?? {} : {}) }
  delete catalogs[identity]
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify({ version: 2, catalogs }, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Remove a catalog snapshot file; safe to call when absent. */
export async function removeCatalogFile(path: string): Promise<void> {
  await rm(path, { force: true })
}
