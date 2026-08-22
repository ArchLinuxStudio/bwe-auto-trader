const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')
const asar = require('@electron/asar')
const {
  collectModuleSpecifiers,
  isForbiddenModuleSpecifier,
  isModuleSpecifier,
} = require('./policy-utils.cjs')

const projectRoot = resolve(__dirname, '..')
const policy = JSON.parse(readFileSync(join(projectRoot, 'licenses', 'production-policy.json'), 'utf8'))
const sourceManifestRaw = readFileSync(join(projectRoot, 'licenses', 'third-party-manifest.json'))
const sourceManifest = JSON.parse(sourceManifestRaw.toString('utf8'))
const sourceNotices = readFileSync(join(projectRoot, sourceManifest.noticesPath))
const sourceProjectLicense = readFileSync(join(projectRoot, 'LICENSE'))
const approvedLicenses = new Set(policy.approvedLicenses)
const forbiddenPackages = new Set(policy.forbiddenPackages)

function fail(message) {
  throw new Error(`[after-pack-license] ${message}`)
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\//, '')
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex').toUpperCase()
}

function packageIdentity(record) {
  return `${record.packageName ?? record.name}\u0000${record.actualName}\u0000${record.version}\u0000${record.license}`
}

function appliesToProfile(record, platform, architecture) {
  return (!record.platforms?.length || record.platforms.includes(platform)) &&
    (!record.architectures?.length || record.architectures.includes(architecture))
}

function packageNameFromPath(value) {
  const normalized = normalizePath(value)
  const marker = 'node_modules/'
  const start = normalized.lastIndexOf(marker)
  if (start < 0) return undefined
  const parts = normalized.slice(start + marker.length).split('/')
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function checkPackageMetadata(packagePath, rawPackageJson) {
  let metadata
  try {
    metadata = JSON.parse(rawPackageJson)
  } catch (error) {
    fail(`invalid packaged package.json at ${packagePath}: ${error.message}`)
  }
  const pathName = packageNameFromPath(packagePath)
  const actualName = metadata.name ?? pathName
  if (!pathName || !actualName) fail(`cannot determine package name for ${packagePath}`)
  if (forbiddenPackages.has(pathName) || forbiddenPackages.has(actualName)) {
    fail(`forbidden packaged dependency: ${pathName} (actual name ${actualName})`)
  }
  if (!approvedLicenses.has(metadata.license)) {
    fail(`unapproved packaged license: ${pathName}@${metadata.version ?? 'unknown'}: ${metadata.license ?? 'missing license'}`)
  }
  return { name: pathName, actualName, version: metadata.version, license: metadata.license }
}

function findNamedFiles(root, filename) {
  const found = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && entry.name === filename) found.push(absolute)
    }
  }
  visit(root)
  return found
}

function checkCompiledFile(contents, source, requireTeleproto = false) {
  const specifiers = collectModuleSpecifiers(contents, source)
  const forbidden = specifiers.filter(({ value }) =>
    isForbiddenModuleSpecifier(value, policy.forbiddenPackages),
  )
  if (forbidden.length > 0) {
    fail(`forbidden module specifier in ${source}: ${forbidden.map(({ value, line }) => `${value}:${line}`).join(', ')}`)
  }
  if (requireTeleproto && !specifiers.some(({ value }) => isModuleSpecifier(value, 'teleproto'))) {
    fail(`${source} does not import teleproto`)
  }
}

function discoverPackagedProfile(packages, manifest) {
  const actual = new Set(packages.map(packageIdentity))
  const profiles = new Map()
  for (const record of manifest.packages ?? []) {
    for (const platform of record.platforms ?? []) {
      for (const architecture of record.architectures ?? []) {
        profiles.set(`${platform}-${architecture}`, { platform, architecture })
      }
    }
  }

  const matches = []
  for (const profile of profiles.values()) {
    const expected = new Set(
      manifest.packages
        .filter((record) => appliesToProfile(record, profile.platform, profile.architecture))
        .map(packageIdentity),
    )
    if (
      expected.size === actual.size &&
      [...expected].every((identity) => actual.has(identity))
    ) {
      matches.push(profile)
    }
  }
  if (matches.length !== 1) {
    fail(`packaged dependency set does not match exactly one reviewed target profile (matched ${matches.length})`)
  }
  return matches[0]
}

function checkRuntimeLicenseFiles(appOutDir, manifest, profile) {
  const runtimes = (manifest.runtimeComponents ?? []).filter((record) =>
    appliesToProfile(record, profile.platform, profile.architecture),
  )
  if (runtimes.length !== 1) {
    fail(`no unique reviewed runtime inventory for ${profile.platform}-${profile.architecture}`)
  }
  const runtime = runtimes[0]
  for (const licenseFile of runtime.licenseFiles ?? []) {
    const packagedPath = join(appOutDir, licenseFile.packagedPath)
    if (!existsSync(packagedPath)) fail(`packaged runtime license file is missing: ${licenseFile.packagedPath}`)
    const contents = readFileSync(packagedPath)
    if (sha256(contents) !== licenseFile.sha256) {
      fail(`packaged runtime license hash differs for ${licenseFile.packagedPath}`)
    }
    if (
      licenseFile.packagedPath === 'LICENSES.chromium.html' &&
      (!contents.includes(Buffer.from('GNU Lesser General Public License')) ||
        !contents.includes(Buffer.from('FFmpeg')))
    ) {
      fail('packaged Chromium license inventory lacks the reviewed LGPL/FFmpeg notices')
    }
  }
}

function checkVisibleComplianceFiles(appOutDir, manifest) {
  const exactFiles = [
    ['LICENSE', sourceProjectLicense],
    [manifest.noticesPath, sourceNotices],
    ['licenses/third-party-manifest.json', sourceManifestRaw],
  ]
  for (const [relativePath, expected] of exactFiles) {
    const packagedPath = join(appOutDir, relativePath)
    if (!existsSync(packagedPath)) fail(`visible compliance file is missing: ${relativePath}`)
    if (!readFileSync(packagedPath).equals(expected)) {
      fail(`visible compliance file differs from the reviewed source: ${relativePath}`)
    }
  }
  for (const evidence of manifest.evidence ?? []) {
    const packagedPath = join(appOutDir, evidence.path)
    if (!existsSync(packagedPath)) fail(`visible license evidence is missing: ${evidence.path}`)
    if (sha256(readFileSync(packagedPath)) !== evidence.sha256) {
      fail(`visible license evidence hash differs for ${evidence.path}`)
    }
  }
}

function checkAsar(asarPath) {
  const rawEntries = asar.listPackage(asarPath)
  const entries = rawEntries.map((entry) => ({ raw: entry.replace(/^[/\\]/, ''), normalized: normalizePath(entry) }))
  const forbiddenPaths = entries
    .filter(({ normalized }) => {
      const name = packageNameFromPath(normalized)
      return name && forbiddenPackages.has(name)
    })
    .map(({ normalized }) => normalized)
  if (forbiddenPaths.length > 0) fail(`forbidden paths in app.asar: ${forbiddenPaths.slice(0, 10).join(', ')}`)

  const packageEntries = entries.filter(({ normalized }) =>
    /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(normalized),
  )
  const packages = packageEntries.map(({ raw, normalized }) =>
    checkPackageMetadata(normalized, asar.extractFile(asarPath, raw).toString('utf8')),
  )

  const teleproto = packages.find(({ name, actualName }) => name === 'teleproto' && actualName === 'teleproto')
  const requirement = policy.requiredPackages.teleproto
  if (teleproto?.version !== requirement.version || teleproto?.license !== requirement.license) {
    fail(`app.asar must contain teleproto ${requirement.version} under ${requirement.license}`)
  }
  const teleprotoLicense = entries.find(({ normalized }) => normalized === 'node_modules/teleproto/LICENSE')
  if (!teleprotoLicense) {
    fail('app.asar does not contain the teleproto MIT LICENSE file')
  }
  const teleprotoLicenseHash = createHash('sha256')
    .update(asar.extractFile(asarPath, teleprotoLicense.raw))
    .digest('hex')
    .toUpperCase()
  if (teleprotoLicenseHash !== requirement.licenseSha256) {
    fail('app.asar contains an unreviewed teleproto LICENSE file')
  }

  const compiledEntries = entries.filter(({ normalized }) =>
    normalized.startsWith('out/') && /\.(?:c|m)?js$/i.test(normalized),
  )
  const mainEntry = compiledEntries.find(({ normalized }) => normalized === 'out/main/index.js')
  if (!mainEntry) fail('app.asar does not contain out/main/index.js')
  for (const entry of compiledEntries) {
    checkCompiledFile(
      asar.extractFile(asarPath, entry.raw).toString('utf8'),
      `${asarPath}:${entry.normalized}`,
      entry === mainEntry,
    )
  }
  return packages
}

function checkUnpackedDirectory(unpackedRoot) {
  if (!existsSync(unpackedRoot)) return []
  const files = findNamedFiles(unpackedRoot, 'package.json')
  const packages = []
  for (const file of files) {
    const rel = normalizePath(relative(unpackedRoot, file))
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(rel)) continue
    packages.push(checkPackageMetadata(rel, readFileSync(file, 'utf8')))
  }

  const allPaths = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      allPaths.push(normalizePath(relative(unpackedRoot, absolute)))
      if (entry.isDirectory()) visit(absolute)
    }
  }
  visit(unpackedRoot)
  const forbiddenPaths = allPaths.filter((value) => {
    const name = packageNameFromPath(value)
    return name && forbiddenPackages.has(name)
  })
  if (forbiddenPaths.length > 0) fail(`forbidden paths in app.asar.unpacked: ${forbiddenPaths.slice(0, 10).join(', ')}`)
  return packages
}

module.exports = async function afterPackLicenseCheck(context) {
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir)
  const asarPath = join(resourcesDir, 'app.asar')
  if (!existsSync(asarPath)) fail(`app.asar not found at ${asarPath}`)

  const packages = [
    ...checkAsar(asarPath),
    ...checkUnpackedDirectory(`${asarPath}.unpacked`),
  ]

  const uniquePackages = [...new Map(packages.map((record) => [packageIdentity(record), record])).values()]
  const profile = discoverPackagedProfile(uniquePackages, sourceManifest)
  checkVisibleComplianceFiles(context.appOutDir, sourceManifest)
  checkRuntimeLicenseFiles(context.appOutDir, sourceManifest, profile)

  const summary = uniquePackages.map(({ name, version, license }) => `${name}@${version} (${license})`).sort()
  console.log(`[after-pack-license] verified ${summary.length} packaged dependencies and runtime notices for ${profile.platform}-${profile.architecture} in ${asarPath}`)
}
