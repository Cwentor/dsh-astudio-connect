/**
 * AStudio model visibility persistence. Hidden-model preferences are kept
 * per identity under the DSH home. Hiding removes a model from catalog reads
 * (`listModels`), which is what the picker renders; history and request routing
 * for an already-selected model are untouched, but a session whose selection is
 * no longer in the catalog must pick another before it can send again.
 *
 * @module dsh-astudio-connect/visibility-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Filename for the visibility file inside the DSH home. */
export const ASTRO_VISIBILITY_FILENAME = '.astudio-connect/model-visibility.json'

/** Visibility store surface used by the catalog. */
export interface AStudioVisibilityStore {
  hidden(identity: string): readonly string[]
  setVisible(identity: string, modelId: string, visible: boolean): Promise<void>
}

/** On-disk document shape; readers reject other versions. */
export interface AStudioVisibilityFile {
  version: 1
  visibility: Record<string, { hidden: string[] }>
}

/** File path for the visibility file. */
export function astudioVisibilityPath(): string {
  return join(resolveDshHome(), ASTRO_VISIBILITY_FILENAME)
}

/** Read one identity's hidden model ids. */
export function readHiddenModels(path: string, identity: string): readonly string[] {
  if (!existsSync(path)) return []
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as AStudioVisibilityFile
    if (file.version !== 1) return []
    return file.visibility[identity]?.hidden ?? []
  } catch {
    return []
  }
}

/** Set one model visible/hidden for one identity. */
export async function setModelVisible(path: string, identity: string, modelId: string, visible: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const file = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const parsed = JSON.parse(file) as AStudioVisibilityFile
  const existing = new Set(parsed.visibility?.[identity]?.hidden ?? [])
  if (visible) existing.delete(modelId)
  else existing.add(modelId)
  const next: AStudioVisibilityFile = {
    version: 1,
    visibility: {
      ...parsed.visibility,
      [identity]: { hidden: [...existing] },
    },
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Create a store bound to one path. */
export function createAStudioVisibilityStore(path: string = astudioVisibilityPath()) {
  return {
    hidden: (identity: string) => readHiddenModels(path, identity),
    setVisible: (identity: string, modelId: string, visible: boolean) => setModelVisible(path, identity, modelId, visible),
  }
}
