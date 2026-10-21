import { describe, it, expect } from 'vitest'
import {
  ASTRO_HOME_ENV,
  DEFAULT_PROFILE,
  candidateAstudioHomes,
  resolveAstudioHome,
  parseStorageRegistry,
  readStorageRegistry,
  configPathForHome,
  sessionFilePathForHome,
  pathDialectOf,
} from '../src/locations.ts'

const WIN_DATA_ROOT = 'D:\\IDE\\AStudio Data'
const POSIX_DATA_ROOT = '/home/dev/.local/share/AStudio Data'

describe('parseStorageRegistry', () => {
  it('reads the production data root and acode home from registry output', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\AStudioStorage',
      '    ProductionSchemaVersion    REG_DWORD    0x1',
      `    ProductionDataRoot    REG_SZ    ${WIN_DATA_ROOT}`,
      `    ProductionManagedStorageRoot    REG_SZ    ${WIN_DATA_ROOT}`,
      '    ProductionAcodeHome    REG_SZ    D:\\IDE\\AStudio Data\\runtime\\acode-home',
      '    ProductionLegacyData    REG_DWORD    0x0',
      '',
    ].join('\r\n')

    const parsed = parseStorageRegistry(output, DEFAULT_PROFILE)
    expect(parsed).toEqual({
      dataRoot: WIN_DATA_ROOT,
      acodeHome: 'D:\\IDE\\AStudio Data\\runtime\\acode-home',
    })
  })

  it('returns undefined when the registry has no record for the profile', () => {
    const output = 'HKEY_CURRENT_USER\\Software\\AStudioStorage\r\n'
    expect(parseStorageRegistry(output, DEFAULT_PROFILE)).toBeUndefined()
  })

  it('rejects an unsupported schema version rather than guessing paths', () => {
    const output = [
      '    ProductionSchemaVersion    REG_DWORD    0x2',
      `    ProductionDataRoot    REG_SZ    ${WIN_DATA_ROOT}`,
      '    ProductionAcodeHome    REG_SZ    D:\\IDE\\AStudio Data\\runtime\\acode-home',
      '',
    ].join('\r\n')

    expect(() => parseStorageRegistry(output, DEFAULT_PROFILE)).toThrow(/schema/i)
  })

  it('rejects an incomplete record rather than half-resolving it', () => {
    const output = [
      '    ProductionSchemaVersion    REG_DWORD    0x1',
      `    ProductionDataRoot    REG_SZ    ${WIN_DATA_ROOT}`,
      '',
    ].join('\r\n')

    expect(() => parseStorageRegistry(output, DEFAULT_PROFILE)).toThrow(/incomplete/i)
  })
})

describe('candidateAstudioHomes', () => {
  it('puts an explicit path first and does not append fallbacks', () => {
    const candidates = candidateAstudioHomes({ explicit: 'E:\\Custom Home' })
    expect(candidates).toEqual(['E:\\Custom Home'])
  })

  it('prefers the environment override over registry and defaults', () => {
    const candidates = candidateAstudioHomes({ env: { [ASTRO_HOME_ENV]: 'E:\\Env Home' } })
    expect(candidates[0]).toBe('E:\\Env Home')
  })

  it('derives the install-sibling data directory as a last resort on Windows', () => {
    const candidates = candidateAstudioHomes({
      platform: 'win32',
      env: {},
      registryOutput: '',
      executablePath: 'D:\\IDE\\AStudio\\AStudio.exe',
    })
    // Exact, not `toContain`: the regression was a *degraded* string
    // ("../AStudio Data") produced when the host's POSIX dirname met a Windows
    // exec path, and a substring check cannot see that.
    expect(candidates).toEqual(['D:\\IDE\\AStudio Data'])
  })

  it('returns no candidates on non-Windows platforms', () => {
    const candidates = candidateAstudioHomes({ platform: 'darwin', env: {}, registryOutput: '' })
    expect(candidates).toEqual([])
  })
})

describe('resolveAstudioHome', () => {
  it('prefers a candidate whose data root exists over an earlier stale one', () => {
    const home = resolveAstudioHome({
      platform: 'win32',
      env: {},
      registryOutput: '',
      executablePath: 'D:\\IDE\\AStudio\\AStudio.exe',
      isReadable: (path) => path === 'D:\\IDE\\AStudio Data',
    })
    expect(home).toEqual({ ok: true, home: 'D:\\IDE\\AStudio Data', source: 'install-sibling' })
  })

  it('reports a diagnostic instead of a bare failure when nothing resolves', () => {
    const home = resolveAstudioHome({
      platform: 'win32',
      env: {},
      registryOutput: '',
      isReadable: () => false,
    })
    expect(home.ok).toBe(false)
    if (home.ok) return
    expect(home.reason).toMatch(/AStudio/i)
  })
})

describe('pathDialectOf', () => {
  it('reads a drive-letter path as Windows', () => {
    expect(pathDialectOf('D:\\IDE\\AStudio Data')).toBe('win32')
    expect(pathDialectOf('D:/IDE/AStudio Data')).toBe('win32')
  })

  it('reads a UNC path as Windows', () => {
    expect(pathDialectOf('\\\\server\\share\\AStudio Data')).toBe('win32')
  })

  it('reads an absolute POSIX path as posix', () => {
    expect(pathDialectOf(POSIX_DATA_ROOT)).toBe('posix')
    expect(pathDialectOf('/opt/astudio')).toBe('posix')
  })
})

describe('configPathForHome and sessionFilePathForHome', () => {
  // Asserted as literals, not via node:path: the point of these cases is that
  // the answer is the same whichever host runs them. Building the expectation
  // with the ambient `join` would make the test agree with a bug instead of
  // catching it (that is exactly how the mixed-separator path shipped).
  it('places config.toml under runtime/acode-home, in the root\'s own dialect', () => {
    expect(configPathForHome(WIN_DATA_ROOT)).toBe('D:\\IDE\\AStudio Data\\runtime\\acode-home\\config.toml')
    expect(configPathForHome(POSIX_DATA_ROOT)).toBe('/home/dev/.local/share/AStudio Data/runtime/acode-home/config.toml')
  })

  it('places astron-session.json under userdata, in the root\'s own dialect', () => {
    expect(sessionFilePathForHome(WIN_DATA_ROOT)).toBe('D:\\IDE\\AStudio Data\\userdata\\astron-session.json')
    expect(sessionFilePathForHome(POSIX_DATA_ROOT)).toBe('/home/dev/.local/share/AStudio Data/userdata/astron-session.json')
  })
})

describe('readStorageRegistry', () => {
  it('queries the registry and parses the record through the injected runner', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\AStudioStorage',
      '    ProductionSchemaVersion    REG_DWORD    0x1',
      `    ProductionDataRoot    REG_SZ    ${WIN_DATA_ROOT}`,
      '    ProductionAcodeHome    REG_SZ    D:\\IDE\\AStudio Data\\runtime\\acode-home',
      '',
    ].join('\r\n')

    const seen: string[][] = []
    const record = readStorageRegistry({
      platform: 'win32',
      run: (command, args) => {
        seen.push([command, ...args])
        return { status: 0, stdout: output }
      },
    })

    expect(record).toEqual({
      dataRoot: WIN_DATA_ROOT,
      acodeHome: 'D:\\IDE\\AStudio Data\\runtime\\acode-home',
    })
    expect(seen[0]?.[0]).toBe('reg.exe')
    expect(seen[0]?.join(' ')).toContain('AStudioStorage')
  })

  it('treats a non-zero exit as no record rather than a crash', () => {
    const record = readStorageRegistry({
      platform: 'win32',
      run: () => ({ status: 1, stdout: '' }),
    })
    expect(record).toBeUndefined()
  })

  it('does not query the registry on non-Windows platforms', () => {
    let called = false
    const record = readStorageRegistry({
      platform: 'darwin',
      run: () => {
        called = true
        return { status: 0, stdout: '' }
      },
    })
    expect(record).toBeUndefined()
    expect(called).toBe(false)
  })
})
