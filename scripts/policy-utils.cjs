const ts = require('typescript')

function packageNameFromLockPath(lockPath) {
  const normalized = String(lockPath).replaceAll('\\', '/')
  const marker = 'node_modules/'
  const start = normalized.lastIndexOf(marker)
  if (start < 0) return undefined
  const parts = normalized.slice(start + marker.length).split('/')
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
}

function dependencySpecNamesPackage(spec, packageName) {
  return typeof spec === 'string' && (
    spec === `npm:${packageName}` || spec.startsWith(`npm:${packageName}@`)
  )
}

function findForbiddenLockEntries(lock, forbiddenPackages) {
  const forbidden = new Set(forbiddenPackages)
  const problems = []
  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    const pathName = packageNameFromLockPath(lockPath)
    if (pathName && forbidden.has(pathName)) problems.push(`${lockPath} (path name ${pathName})`)
    if (metadata.name && forbidden.has(metadata.name)) {
      problems.push(`${lockPath} (actual name ${metadata.name})`)
    }
    for (const [declaredName, spec] of Object.entries({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
      ...metadata.peerDependencies,
    })) {
      if (forbidden.has(declaredName)) {
        problems.push(`${lockPath} -> ${declaredName}`)
      }
      for (const forbiddenName of forbidden) {
        if (dependencySpecNamesPackage(spec, forbiddenName)) {
          problems.push(`${lockPath} -> ${declaredName} aliases ${forbiddenName}`)
        }
      }
    }
  }
  return [...new Set(problems)].sort()
}

function resolveLockDependency(packages, parentPath, packageName) {
  let ancestor = parentPath
  while (true) {
    const candidate = ancestor
      ? `${ancestor}/node_modules/${packageName}`
      : `node_modules/${packageName}`
    if (packages[candidate]) return candidate
    if (!ancestor) return undefined
    const nestedMarker = ancestor.lastIndexOf('/node_modules/')
    ancestor = nestedMarker >= 0 ? ancestor.slice(0, nestedMarker) : ''
  }
}

function collectProductionLockPackages(lock) {
  const packages = lock.packages ?? {}
  const root = packages['']
  if (!root) throw new Error('package-lock.json is missing its root package entry')

  const reachable = new Map()
  const queue = []
  const enqueueDependencies = (parentPath, dependencies, optional) => {
    for (const name of Object.keys(dependencies ?? {})) queue.push({ parentPath, name, optional })
  }
  enqueueDependencies('', root.dependencies, false)
  enqueueDependencies('', root.optionalDependencies, true)

  while (queue.length > 0) {
    const { parentPath, name, optional } = queue.shift()
    const lockPath = resolveLockDependency(packages, parentPath, name)
    if (!lockPath) {
      if (optional) continue
      throw new Error(`cannot resolve production dependency ${name} from ${parentPath || '<root>'}`)
    }
    if (reachable.has(lockPath)) continue

    const metadata = packages[lockPath]
    reachable.set(lockPath, metadata)
    enqueueDependencies(lockPath, metadata.dependencies, false)
    enqueueDependencies(lockPath, metadata.optionalDependencies, true)
    // Installed peer dependencies are part of the runtime closure. Missing
    // peers are left to npm's own invalid-tree check.
    enqueueDependencies(lockPath, metadata.peerDependencies, true)
  }
  return reachable
}

function isForbiddenModuleSpecifier(specifier, forbiddenPackages) {
  return forbiddenPackages.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  )
}

function isModuleSpecifier(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`)
}

function collectModuleSpecifiers(sourceText, filename = 'compiled.js') {
  const sourceFile = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.JS,
  )
  const specifiers = []
  const addLiteral = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      specifiers.push({ value: node.text, line: location.line + 1 })
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addLiteral(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      addLiteral(node.moduleReference.expression)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const expressionText = node.expression.getText(sourceFile).replaceAll(' ', '')
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        expressionText === 'require' ||
        expressionText === 'require.resolve' ||
        expressionText === 'module.require' ||
        expressionText === 'import.meta.resolve'
      ) {
        addLiteral(node.arguments[0])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

module.exports = {
  collectModuleSpecifiers,
  collectProductionLockPackages,
  dependencySpecNamesPackage,
  findForbiddenLockEntries,
  isForbiddenModuleSpecifier,
  isModuleSpecifier,
  packageNameFromLockPath,
}
