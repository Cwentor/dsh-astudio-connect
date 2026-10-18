/**
 * AStudio catalog persistence. One file under the DSH home keeps the last
 * successful model snapshot per identity, so a restart or a failed fetch can
 * serve the account's last good roster instead of the compiled-in fallback.
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
  version: 1
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

/** Read a snapshot for one identity, or undefined when none is saved. */
export async function readCatalogSnapshot(path: string, identity: string): Promise<AStudioCatalogSnapshot | undefined> {
  try {
    const file = JSON.parse(await readFile(path, 'utf8')) as AStudioCatalogFile
    if (file.version !== 1) return undefined
    const snapshot = file.catalogs[identity]
    if (snapshot === undefined) return undefined
    if (!Array.isArray(snapshot.models)) return undefined
    return snapshot
  } catch {
    return undefined
  }
}

/** Write a snapshot for one identity with a sibling temp file plus rename. */
export async function writeCatalogSnapshot(path: string, identity: string, models: readonly AStudioModelInfo[], fetchedAtMs: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const file = await readFile(path, 'utf8').catch(() => '{}')
  const parsed = JSON.parse(file) as AStudioCatalogFile
  const next: AStudioCatalogFile = {
    version: 1,
    catalogs: {
      ...parsed.catalogs,
      [identity]: { fetchedAtMs, models: [...models] },
    },
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Remove one identity's snapshot. */
export async function deleteCatalogSnapshot(path: string, identity: string): Promise<void> {
  const file = await readFile(path, 'utf8').catch(() => '{}')
  const parsed = JSON.parse(file) as AStudioCatalogFile
  const catalogs = { ...parsed.catalogs }
  delete catalogs[identity]
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify({ version: 1, catalogs }, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Remove a catalog snapshot file; safe to call when absent. */
export async function removeCatalogFile(path: string): Promise<void> {
  await rm(path, { force: true })
}
