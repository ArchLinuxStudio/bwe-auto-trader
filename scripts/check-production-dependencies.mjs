import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  collectProductionLockPackages,
  dependencySpecNamesPackage,
  findForbiddenLockEntries,
  packageNameFromLockPath,
} = require('./policy-utils.cjs')
const packageJson = readJson('package.json')
const lock = readJson('package-lock.json')
const policy = readJson('licenses/production-policy.json')
const thirdPartyManifest = readJson('licenses/third-party-manifest.json')
const thirdPartyNotices = readFileSync(resolve(projectRoot, thirdPartyManifest.noticesPath), 'utf8')

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(projectRoot, relativePath), 'utf8'))
}

function fail(message) {
  throw new Error(`[dependency-policy] ${message}`)
}

function sortedRecord(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
}

function sameStringArray(left, right) {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort())
}

function packageIdentity({ packageName, actualName, version, license }) {
  return `${packageName}\u0000${actualName}\u0000${version}\u0000${license}`
}

function appliesToCurrentPlatform(record) {
  return (!record.platforms?.length || record.platforms.includes(process.platform)) &&
    (!record.architectures?.length || record.architectures.includes(process.arch))
}

if (lock.version !== packageJson.version || lock.packages?.['']?.version !== packageJson.version) {
  fail('package.json and package-lock.json versions differ')
}

const manifestDependencies = sortedRecord(packageJson.dependencies)
const lockedRootDependencies = sortedRecord(lock.packages?.['']?.dependencies)
if (JSON.stringify(manifestDependencies) !== JSON.stringify(lockedRootDependencies)) {
  fail('root production dependencies differ between package.json and package-lock.json')
}
const manifestOptionalDependencies = sortedRecord(packageJson.optionalDependencies)
const lockedRootOptionalDependencies = sortedRecord(lock.packages?.['']?.optionalDependencies)
if (JSON.stringify(manifestOptionalDependencies) !== JSON.stringify(lockedRootOptionalDependencies)) {
  fail('root optional dependencies differ between package.json and package-lock.json')
}

const forbidden = new Set(policy.forbiddenPackages)
for (const [section, dependencies] of Object.entries({
  dependencies: packageJson.dependencies,
  optionalDependencies: packageJson.optionalDependencies,
  devDependencies: packageJson.devDependencies,
})) {
  for (const [declaredName, spec] of Object.entries(dependencies ?? {})) {
    if (forbidden.has(declaredName)) fail(`forbidden ${section} entry: ${declaredName}`)
    for (const forbiddenName of forbidden) {
      if (dependencySpecNamesPackage(spec, forbiddenName)) {
        fail(`${section}.${declaredName} aliases forbidden package ${forbiddenName}`)
      }
    }
  }
}
const forbiddenLockEntries = findForbiddenLockEntries(lock, policy.forbiddenPackages)
if (forbiddenLockEntries.length > 0) {
  fail(`forbidden packages remain in package-lock.json: ${forbiddenLockEntries.join(', ')}`)
}

const approvedLicenses = new Set(policy.approvedLicenses)
let productionLockPackages
try {
  productionLockPackages = [...collectProductionLockPackages(lock).entries()]
} catch (error) {
  fail(error.message)
}
const lockLicenseProblems = productionLockPackages
  .filter(([, metadata]) => !approvedLicenses.has(metadata.license))
  .map(([lockPath, metadata]) => `${lockPath}: ${metadata.license ?? 'missing license'}`)
if (lockLicenseProblems.length > 0) {
  fail(`unapproved production licenses in package-lock.json:\n${lockLicenseProblems.join('\n')}`)
}

if (thirdPartyManifest.schemaVersion !== 1 || thirdPartyManifest.appVersion !== packageJson.version) {
  fail('third-party manifest schema or app version is stale')
}
if (thirdPartyManifest.noticesPath !== 'THIRD_PARTY_NOTICES.txt') {
  fail('third-party manifest must point to THIRD_PARTY_NOTICES.txt')
}

const manifestPackagesByLockPath = new Map()
for (const record of thirdPartyManifest.packages ?? []) {
  if (!record.lockPath || manifestPackagesByLockPath.has(record.lockPath)) {
    fail(`duplicate or missing third-party manifest lockPath: ${record.lockPath ?? '<missing>'}`)
  }
  manifestPackagesByLockPath.set(record.lockPath, record)
}
if (manifestPackagesByLockPath.size !== productionLockPackages.length) {
  fail(`third-party manifest package count ${manifestPackagesByLockPath.size} differs from lock closure ${productionLockPackages.length}`)
}

for (const [lockPath, metadata] of productionLockPackages) {
  const record = manifestPackagesByLockPath.get(lockPath)
  if (!record) fail(`third-party manifest is missing ${lockPath}`)
  const packageName = packageNameFromLockPath(lockPath)
  const actualName = metadata.name ?? packageName
  if (
    record.packageName !== packageName ||
    record.actualName !== actualName ||
    record.version !== metadata.version ||
    record.license !== metadata.license ||
    !sameStringArray(record.platforms, metadata.os) ||
    !sameStringArray(record.architectures, metadata.cpu)
  ) {
    fail(`third-party manifest metadata differs from package-lock.json at ${lockPath}`)
  }
  if (record.noticeToken !== `${packageName}@${metadata.version}`) {
    fail(`third-party manifest notice token is stale for ${lockPath}`)
  }
  if (!thirdPartyNotices.includes(`Package-ID: ${record.noticeToken}`)) {
    fail(`THIRD_PARTY_NOTICES.txt is missing ${record.noticeToken}`)
  }
}

const evidenceById = new Map()
for (const evidence of thirdPartyManifest.evidence ?? []) {
  if (!evidence.id || evidenceById.has(evidence.id)) {
    fail(`duplicate or missing license evidence id: ${evidence.id ?? '<missing>'}`)
  }
  if (!/^licenses\/third-party\/[A-Za-z0-9@._-]+$/.test(evidence.path)) {
    fail(`unsafe license evidence path: ${evidence.path}`)
  }
  const evidencePath = resolve(projectRoot, evidence.path)
  if (sha256File(evidencePath) !== evidence.sha256) {
    fail(`license evidence hash differs for ${evidence.path}`)
  }
  evidenceById.set(evidence.id, evidence)
}
for (const record of thirdPartyManifest.packages ?? []) {
  const evidence = (record.evidence ?? []).map((id) => evidenceById.get(id))
  if (evidence.some((item) => !item) || !evidence.some((item) => item.kind === 'license')) {
    fail(`third-party manifest lacks valid license evidence for ${record.noticeToken}`)
  }
  if (record.actualName === '@openai/codex' && !evidence.some((item) => item.kind === 'notice')) {
    fail(`${record.noticeToken} must preserve the upstream Apache NOTICE`)
  }
}

const currentRuntime = (thirdPartyManifest.runtimeComponents ?? []).filter(appliesToCurrentPlatform)
if (currentRuntime.length !== 1) {
  fail(`expected one reviewed runtime record for ${process.platform}-${process.arch}, found ${currentRuntime.length}`)
}
const electronRuntime = currentRuntime[0]
if (electronRuntime.name !== 'Electron' || electronRuntime.version !== packageJson.devDependencies.electron) {
  fail('Electron runtime inventory does not match the pinned build runtime')
}
for (const licenseFile of electronRuntime.licenseFiles ?? []) {
  if (sha256File(resolve(projectRoot, licenseFile.sourcePath)) !== licenseFile.sha256) {
    fail(`Electron runtime license inventory differs for ${licenseFile.sourcePath}`)
  }
}
const electronChecksums = readJson('node_modules/electron/checksums.json')
if (
  electronChecksums[electronRuntime.binaryArchive]?.toUpperCase() !== electronRuntime.binaryArchiveSha256 ||
  electronChecksums[electronRuntime.ffmpegArchive]?.toUpperCase() !== electronRuntime.ffmpegArchiveSha256
) {
  fail('Electron runtime archive provenance differs from the pinned checksums')
}
const chromiumLicenses = readFileSync(resolve(projectRoot, 'node_modules/electron/dist/LICENSES.chromium.html'), 'utf8')
if (!chromiumLicenses.includes('GNU Lesser General Public License') || !chromiumLicenses.includes('FFmpeg')) {
  fail('Chromium runtime license inventory no longer contains the reviewed LGPL/FFmpeg notices')
}
if (!thirdPartyNotices.includes('LICENSE.electron.txt') || !thirdPartyNotices.includes('LICENSES.chromium.html')) {
  fail('THIRD_PARTY_NOTICES.txt does not explain the Electron/Chromium runtime license boundary')
}

for (const [name, requirement] of Object.entries(policy.requiredPackages)) {
  if (packageJson.dependencies?.[name] !== requirement.version) {
    fail(`${name} must be pinned exactly to ${requirement.version}`)
  }
  const locked = lock.packages?.[`node_modules/${name}`]
  if (locked?.version !== requirement.version || locked?.license !== requirement.license) {
    fail(`${name} lock entry must be ${requirement.version} under ${requirement.license}`)
  }
  if (locked.resolved !== requirement.resolved || locked.integrity !== requirement.integrity) {
    fail(`${name} lock entry does not match the reviewed registry provenance and integrity`)
  }
  if (requirement.licenseSha256) {
    const licensePath = resolve(projectRoot, 'node_modules', name, 'LICENSE')
    const licenseHash = createHash('sha256').update(readFileSync(licensePath)).digest('hex').toUpperCase()
    if (licenseHash !== requirement.licenseSha256) {
      fail(`${name} LICENSE hash does not match the reviewed ${requirement.license} text`)
    }
  }
}

const npmCommand = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
const npmArguments = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm.cmd', 'ls', '--omit=dev', '--all', '--json', '--long']
  : ['ls', '--omit=dev', '--all', '--json', '--long']
let installedTree
try {
  installedTree = JSON.parse(
    execFileSync(npmCommand, npmArguments, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  )
} catch (error) {
  const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : ''
  let problems = []
  try {
    problems = JSON.parse(stdout).problems ?? []
  } catch {
    // Preserve npm's own diagnostic if it did not return JSON.
  }
  fail(`npm production tree is invalid: ${problems.join('; ') || stderr || error.message}`)
}

if (installedTree.problems?.length) {
  fail(`npm production tree reports: ${installedTree.problems.join('; ')}`)
}

const installedPackages = []
const installedPackageRecords = new Map()
function walkInstalled(dependencies) {
  for (const [installedName, metadata] of Object.entries(dependencies ?? {})) {
    // npm represents optional packages for other operating systems as empty
    // placeholder objects under the parent dependency.
    if (!metadata.version && !metadata.missing && Object.keys(metadata).length === 0) continue
    if (forbidden.has(installedName) || forbidden.has(metadata.name)) {
      fail(`forbidden installed package: ${installedName} (actual name ${metadata.name ?? installedName})`)
    }
    if (metadata.missing || metadata.invalid || metadata.extraneous) {
      fail(`invalid installed package: ${installedName}@${metadata.version ?? 'unknown'}`)
    }
    if (!approvedLicenses.has(metadata.license)) {
      fail(`unapproved installed license: ${installedName}@${metadata.version ?? 'unknown'}: ${metadata.license ?? 'missing license'}`)
    }
    installedPackages.push(`${installedName}@${metadata.version} (${metadata.license})`)
    const record = {
      packageName: installedName,
      actualName: metadata.name ?? installedName,
      version: metadata.version,
      license: metadata.license,
    }
    installedPackageRecords.set(packageIdentity(record), record)
    walkInstalled(metadata.dependencies)
  }
}
walkInstalled(installedTree.dependencies)

const expectedInstalledIdentities = new Set(
  thirdPartyManifest.packages.filter(appliesToCurrentPlatform).map(packageIdentity),
)
const actualInstalledIdentities = new Set(installedPackageRecords.keys())
const missingInstalled = [...expectedInstalledIdentities].filter((identity) => !actualInstalledIdentities.has(identity))
const unexpectedInstalled = [...actualInstalledIdentities].filter((identity) => !expectedInstalledIdentities.has(identity))
if (missingInstalled.length || unexpectedInstalled.length) {
  fail(`installed production tree differs from the reviewed third-party manifest (missing ${missingInstalled.length}, unexpected ${unexpectedInstalled.length})`)
}

const uniqueInstalledPackages = [...new Set(installedPackages)].sort()
console.log(`[dependency-policy] verified ${uniqueInstalledPackages.length} installed production packages`)
for (const entry of uniqueInstalledPackages) console.log(`  ${entry}`)
