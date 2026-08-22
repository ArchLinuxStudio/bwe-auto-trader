import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

interface ManifestPackage {
  lockPath: string
  packageName: string
  actualName: string
  version: string
  license: string
  platforms?: string[]
  architectures?: string[]
  evidence: string[]
  noticeToken: string
}

interface EvidenceFile {
  id: string
  kind: 'license' | 'notice'
  path: string
  sha256: string
}

interface RuntimeComponent {
  name: string
  version: string
  chromiumVersion: string
  nodeVersion: string
  target: string
  binaryArchive: string
  binaryArchiveSha256: string
  ffmpegArchive: string
  ffmpegArchiveSha256: string
  licenseFiles: Array<{
    packagedPath: string
    sourcePath: string
    sha256: string
  }>
  licenseBoundary: string
}

interface ThirdPartyManifest {
  schemaVersion: number
  appVersion: string
  noticesPath: string
  packages: ManifestPackage[]
  runtimeComponents: RuntimeComponent[]
  evidence: EvidenceFile[]
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { collectProductionLockPackages, packageNameFromLockPath } = require(
  '../scripts/policy-utils.cjs',
) as {
  collectProductionLockPackages(lock: unknown): Map<string, Record<string, unknown>>
  packageNameFromLockPath(path: string): string | undefined
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(projectRoot, path), 'utf8')) as T
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(resolve(projectRoot, path)))
    .digest('hex')
    .toUpperCase()
}

describe('third-party distribution notices', () => {
  it('matches every package in the production lock closure exactly', async () => {
    const lock = await readJson<Record<string, unknown>>('package-lock.json')
    const manifest = await readJson<ThirdPartyManifest>('licenses/third-party-manifest.json')
    const production = [...collectProductionLockPackages(lock)]

    expect(manifest.packages).toHaveLength(production.length)
    for (const [lockPath, metadata] of production) {
      const packageName = packageNameFromLockPath(lockPath)
      const record = manifest.packages.find((item) => item.lockPath === lockPath)
      expect(record).toMatchObject({
        packageName,
        actualName: metadata.name ?? packageName,
        version: metadata.version,
        license: metadata.license,
        noticeToken: `${packageName}@${metadata.version}`,
      })
      expect([...(record?.platforms ?? [])].sort()).toEqual(
        [...((metadata.os as string[] | undefined) ?? [])].sort(),
      )
      expect([...(record?.architectures ?? [])].sort()).toEqual(
        [...((metadata.cpu as string[] | undefined) ?? [])].sort(),
      )
    }
  })

  it('hashes every evidence file and lists every package in the notice', async () => {
    const manifest = await readJson<ThirdPartyManifest>('licenses/third-party-manifest.json')
    const notices = await readFile(resolve(projectRoot, manifest.noticesPath), 'utf8')
    const evidenceById = new Map(manifest.evidence.map((item) => [item.id, item]))

    for (const evidence of manifest.evidence) {
      expect(await sha256(evidence.path)).toBe(evidence.sha256)
    }
    for (const record of manifest.packages) {
      expect(notices).toContain(`Package-ID: ${record.noticeToken}`)
      expect(record.evidence.map((id) => evidenceById.get(id)?.kind)).toContain('license')
    }

    const store2 = manifest.packages.find((record) => record.packageName === 'store2')
    expect(store2).toMatchObject({ license: 'MIT', evidence: ['store2-mit-selection'] })
    expect(notices).toContain('affirmatively elects and uses')
    expect(notices).toContain('the MIT option')

    const codex = manifest.packages.find((record) => record.packageName === '@openai/codex')
    expect(codex?.evidence).toContain('openai-codex-notice')
  })

  it('records and preserves the Electron/Chromium runtime license boundary', async () => {
    const manifest = await readJson<ThirdPartyManifest>('licenses/third-party-manifest.json')
    const packageJson = await readJson<{ devDependencies: Record<string, string> }>('package.json')
    const checksums = await readJson<Record<string, string>>('node_modules/electron/checksums.json')
    const notices = await readFile(resolve(projectRoot, manifest.noticesPath), 'utf8')
    const runtime = manifest.runtimeComponents[0]!

    expect(runtime).toMatchObject({
      name: 'Electron',
      version: packageJson.devDependencies.electron,
      chromiumVersion: '150.0.7871.224',
      nodeVersion: '24.18.1',
      target: 'win32-x64',
    })
    expect(checksums[runtime.binaryArchive]?.toUpperCase()).toBe(runtime.binaryArchiveSha256)
    expect(checksums[runtime.ffmpegArchive]?.toUpperCase()).toBe(runtime.ffmpegArchiveSha256)
    for (const licenseFile of runtime.licenseFiles) {
      expect(await sha256(licenseFile.sourcePath)).toBe(licenseFile.sha256)
    }

    const chromiumLicenses = await readFile(
      resolve(projectRoot, 'node_modules/electron/dist/LICENSES.chromium.html'),
      'utf8',
    )
    expect(chromiumLicenses).toContain('GNU Lesser General Public License')
    expect(chromiumLicenses).toContain('FFmpeg')
    expect(runtime.licenseBoundary).toContain('LGPL-2.1-or-later')
    expect(notices).toContain('must not be')
    expect(notices).toContain('complete Electron installer free')
  })

  it('includes notices in NSIS and portable ZIP packages and shows the project EULA', async () => {
    const packageJson = await readJson<{
      build: {
        directories: { output: string }
        extraFiles: Array<{ from: string; to: string; filter?: string[] }>
        win: { target: Array<{ target: string }>; artifactName: string }
        nsis: { artifactName: string; license: string }
      }
    }>('package.json')

    expect(packageJson.build.extraFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'LICENSE', to: 'LICENSE' }),
      expect.objectContaining({
        from: 'THIRD_PARTY_NOTICES.txt',
        to: 'THIRD_PARTY_NOTICES.txt',
      }),
      expect.objectContaining({
        from: 'licenses',
        to: 'licenses',
        filter: expect.arrayContaining([
          'third-party-manifest.json',
          'third-party/**/*',
        ]),
      }),
    ]))
    expect(packageJson.build.win.target.map(({ target }) => target)).toEqual(['nsis', 'zip'])
    expect(packageJson.build.directories.output).toBe('release-v${version}')
    expect(packageJson.build.win.artifactName).toContain('Portable')
    expect(packageJson.build.nsis.artifactName).toContain('Setup')
    expect(packageJson.build.nsis.license).toBe('LICENSE')
  })
})
