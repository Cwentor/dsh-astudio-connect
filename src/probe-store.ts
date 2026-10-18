/**
 * AStudio reasoning-probe persistence. Probe records are kept per
 * `account:modelId` under the DSH home, so an observation survives restarts
 * and is only reused while it is not expired.
 *
 * @module dsh-astudio-connect/probe-store
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Filename for probe records inside the DSH home. */
export const ASTRO_PROBE_FILENAME = '.astudio-connect/probe.json'

/** One probe observation. */
export interface AStudioProbeRecord {
  account: string
  modelId: string
  validation: 'validating' | 'non-validating'
  efforts: string[]
  expiresAtMs: number
}

/** On-disk document shape; readers reject other versions. */
export interface AStudioProbeFile {
  version: 1
  probes: AStudioProbeRecord[]
}

/** File path for probe records. */
export function astudioProbePath(): string {
  return join(resolveDshHome(), ASTRO_PROBE_FILENAME)
}

/** Read one probe record for one account/model pair, or undefined. */
export function readProbeRecord(path: string, account: string, modelId: string): AStudioProbeRecord | undefined {
  if (!existsSync(path)) return undefined
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as AStudioProbeFile
    if (file.version !== 1) return undefined
    const record = file.probes.find(p => p.account === account && p.modelId === modelId)
    if (record === undefined || record.expiresAtMs <= Date.now()) return undefined
    return record
  } catch {
    return undefined
  }
}

/** Save one probe record. */
export async function writeProbeRecord(path: string, record: AStudioProbeRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const file = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const parsed = JSON.parse(file) as AStudioProbeFile
  const probes = (parsed.probes ?? []).filter(p => !(p.account === record.account && p.modelId === record.modelId))
  const next: AStudioProbeFile = {
    version: 1,
    probes: [...probes, record],
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Clear all probe records for one account. */
export async function clearProbeRecords(path: string, account: string): Promise<void> {
  const file = existsSync(path) ? readFileSync(path, 'utf8') : '{}'
  const parsed = JSON.parse(file) as AStudioProbeFile
  const next: AStudioProbeFile = {
    version: 1,
    probes: (parsed.probes ?? []).filter(p => p.account !== account),
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** Create a store bound to one path. */
export function createAStudioProbeStore(path: string = astudioProbePath()) {
  return {
    get: (account: string, modelId: string) => readProbeRecord(path, account, modelId),
    put: (record: AStudioProbeRecord) => writeProbeRecord(path, record),
    clear: (account: string) => clearProbeRecords(path, account),
  }
}
