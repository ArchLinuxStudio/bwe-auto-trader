import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { IGE } from 'teleproto/crypto/IGE.js'
import { StringSession } from 'teleproto/sessions/index.js'

interface LockedPackage {
  version?: string
  license?: string
  dev?: boolean
  resolved?: string
  integrity?: string
}

interface PackageLock {
  version: string
  packages: Record<string, LockedPackage>
}

interface ProductionPolicy {
  approvedLicenses: string[]
  forbiddenPackages: string[]
  requiredPackages: Record<
    string,
    {
      version: string
      license: string
      resolved: string
      integrity: string
      licenseSha256: string
    }
  >
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  collectModuleSpecifiers,
  findForbiddenLockEntries,
  isForbiddenModuleSpecifier,
} = require('../scripts/policy-utils.cjs') as {
  collectModuleSpecifiers(source: string, filename?: string): Array<{ value: string; line: number }>
  findForbiddenLockEntries(lock: unknown, forbiddenPackages: string[]): string[]
  isForbiddenModuleSpecifier(specifier: string, forbiddenPackages: string[]): boolean
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(projectRoot, relativePath), 'utf8')) as T
}

function syntheticLegacyStringSession(): string {
  // GramJS' fixed-IPv4 StringSession layout is:
  // version + base64(dcId + IPv4 + port + 256-byte auth key).
  // This deterministic key is test data only and is not a real Telegram session.
  const payload = Buffer.concat([
    Buffer.from([2, 149, 154, 167, 51]),
    Buffer.from([0x01, 0xbb]),
    Buffer.alloc(256, 0x42),
  ])
  return `1${payload.toString('base64')}`
}

describe('teleproto migration', () => {
  it('loads and re-saves the legacy GramJS StringSession format', async () => {
    const legacy = syntheticLegacyStringSession()
    expect(legacy).toHaveLength(353)

    const session = new StringSession(legacy)
    await session.load()

    expect(session.dcId).toBe(2)
    expect(session.serverAddress).toBe('149.154.167.51')
    expect(session.port).toBe(443)

    const migrated = session.save()
    expect(migrated).toMatch(/^1[A-Za-z0-9+/=]+$/)

    const reloaded = new StringSession(migrated)
    await reloaded.load()
    expect(reloaded.dcId).toBe(2)
    expect(reloaded.serverAddress).toBe('149.154.167.51')
    expect(reloaded.port).toBe(443)
  })

  it('matches Telegram\'s published AES-IGE authentication vector', () => {
    const data = Buffer.from(
      [
        '54B6436651A1143FC7A3666BE4BE54D6890A02DC63248F6748214EAB8A2F4CC8',
        '76E119740000000000000000FE0001002EE7B6CC1343B2D39A1AAB034551C991',
        '2E5DEE8047C6C62FFBD42B5E1894CFCB79EFEF794135A9FAA3F32C88D5D6D19',
        'F75289A5362984AC02A53A4E49E78C07E78C35FF505BC707F7F64E9AAA4BFBD',
        '0DBB11E3CACE330048C629DB154463731A2833E11130328EDE8C1230B246D1D9',
        '99A0336CAC5B32BE5780253DE10BAA6513A5A079F2B9D6A59DB7799E97915F55',
        '6C89407617BE822C7F65532C8E37792442EDD83793940F5606BC1994B4964ED34',
        '58C9AD513977F217699D32368315C7BB07D99C9EE77DE069E62E4A4DFDB16F4F',
        '911AA1AEF7373A2F49185501BE684A777772BFC4BD99E38FA51014A3E059543B',
        'DCF213977FE913E8A3D881C2EB5523B04',
      ].join(''),
      'hex',
    )
    const padding = Buffer.from('A813B31F76CD0D537283454A', 'hex')
    const key = Buffer.from(
      '16F548177058E8D39C41CBAD4D419446BEB12EB9B8F5AD28EA824B8015F17D81',
      'hex',
    )
    const iv = Buffer.from(
      'C4D14166C1378E35C698460047DBB6075441BE9984611C28837357EBBF8CB5BD',
      'hex',
    )
    const expectedCipherText = Buffer.from(
      [
        '136CA7E1F58C243372404792D3519F815AA6EC5E0324B2B11D89197CE5FFCDC2',
        'E53C5444A399E9C2111C143D1DFDA34932FC5F290EF51E28BE6AD31F68FB6CE9',
        'A8273EAD64262D78A5E132E5789E2620CD9C6E4C0A259E8B154FB07BA4725E9F',
        '883D2FA8EC59CAA7F683586CC35C3231B2023675C2759CB4194F6BBBC46EA478',
        '27CF2B07242357B6FC300EF086AF41D98E06C4DE2FCC41CD9216AF01D30A0DBA',
        '421D928D1D7386ECA1D18CA6772466169173425C272A22D78D9E55BEA4DB25EB',
        '9BD32D31115563AE2BFCD0374CEAEF3E42661F9059228BFCA3DF79F2E77C4AA5',
        'CBCF03963783CE0D6257399F7A4DD644BF1E57F19A9DF46172ECED9610C4F6A5',
        'A57FA4D08173732B1BA95B992B8B633A474A9D8FD18BDC673077178C5C20506F',
        'D226399C1F87D022C5C395428D92B8E4E39218EA68D3D6E010BBFFE839F8D124',
        'C5C458BCDF8FE5F25190F97C0C46C206',
      ].join(''),
      'hex',
    )
    const plainText = Buffer.concat([createHash('sha1').update(data).digest(), data, padding])
    const ige = new IGE(key, iv)

    expect(ige.encryptIge(plainText)).toEqual(expectedCipherText)
    expect(ige.decryptIge(expectedCipherText)).toEqual(plainText)
  })

  it('pins teleproto and keeps the retired GramJS GPL dependency out of the lockfile', async () => {
    const packageJson = await readJson<{
      version: string
      dependencies: Record<string, string>
    }>('package.json')
    const lock = await readJson<PackageLock>('package-lock.json')
    const policy = await readJson<ProductionPolicy>('licenses/production-policy.json')
    const requirement = policy.requiredPackages.teleproto!

    expect(packageJson.dependencies.teleproto).toBe(requirement.version)
    expect(packageJson.dependencies.telegram).toBeUndefined()
    expect(lock.version).toBe(packageJson.version)
    expect(lock.packages['node_modules/teleproto']).toMatchObject({
      version: requirement.version,
      license: requirement.license,
      resolved: requirement.resolved,
      integrity: requirement.integrity,
    })

    const forbiddenPackages = Object.keys(lock.packages).filter(
      (path) => policy.forbiddenPackages.some(
        (name) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`),
      ),
    )
    expect(forbiddenPackages).toEqual([])
  })

  it('enforces the shared production license allowlist against the lockfile', async () => {
    const lock = await readJson<PackageLock>('package-lock.json')
    const policy = await readJson<ProductionPolicy>('licenses/production-policy.json')
    const approvedLicenses = new Set(policy.approvedLicenses)
    const productionPackages = Object.entries(lock.packages).filter(
      ([path, metadata]) => path.length > 0 && metadata.dev !== true,
    )

    const unapprovedPackages = productionPackages
      .filter(([, metadata]) => !metadata.license || !approvedLicenses.has(metadata.license))
      .map(([path, metadata]) => `${path}: ${metadata.license}`)

    expect(unapprovedPackages).toEqual([])
  })

  it.each([
    ['side-effect import', 'import "telegram"'],
    ['CommonJS subpath', 'require("@cryptography/aes/internal")'],
    ['require.resolve', 'require.resolve("telegram/events/index.js")'],
    ['import.meta.resolve', 'import.meta.resolve("telegram")'],
    ['dynamic import', 'import("telegram/sessions/index.js")'],
  ])('detects a forbidden %s in compiled JavaScript', (_label, source) => {
    const specifiers = collectModuleSpecifiers(source, 'fixture.js')
    expect(
      specifiers.some(({ value }) =>
        isForbiddenModuleSpecifier(value, ['telegram', '@cryptography/aes']),
      ),
    ).toBe(true)
  })

  it('does not treat comments or ordinary Telegram UI strings as module imports', () => {
    const specifiers = collectModuleSpecifiers(
      'const label = "telegram"; // require("@cryptography/aes")',
      'fixture.js',
    )
    expect(specifiers).toEqual([])
  })

  it('detects forbidden npm aliases by declared and actual package name', () => {
    const problems = findForbiddenLockEntries(
      {
        packages: {
          '': { dependencies: { harmless: 'npm:telegram@2.26.22' } },
          'node_modules/harmless': { name: 'telegram', version: '2.26.22' },
        },
      },
      ['telegram'],
    )
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('aliases telegram'),
      expect.stringContaining('actual name telegram'),
    ]))
  })
})
