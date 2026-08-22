import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const {
  collectModuleSpecifiers,
  isForbiddenModuleSpecifier,
  isModuleSpecifier,
} = require('./policy-utils.cjs')
const policy = JSON.parse(
  readFileSync(resolve(projectRoot, 'licenses/production-policy.json'), 'utf8'),
)
const mainOutputPath = resolve(projectRoot, 'out/main/index.js')

function findJavaScriptFiles(root) {
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && /\.(?:c|m)?js$/i.test(entry.name)) files.push(absolute)
    }
  }
  visit(root)
  return files
}

const outputFiles = findJavaScriptFiles(resolve(projectRoot, 'out'))
const moduleSpecifiers = outputFiles.flatMap((file) =>
  collectModuleSpecifiers(readFileSync(file, 'utf8'), file).map((entry) => ({ ...entry, file })),
)
const forbidden = moduleSpecifiers.filter(({ value }) =>
  isForbiddenModuleSpecifier(value, policy.forbiddenPackages),
)
if (forbidden.length > 0) {
  const detail = forbidden.map(({ file, line, value }) => `${file}:${line} -> ${value}`).join(', ')
  throw new Error(`[built-output] forbidden dependency remains in compiled output: ${detail}`)
}

const mainSpecifiers = collectModuleSpecifiers(readFileSync(mainOutputPath, 'utf8'), mainOutputPath)
if (!mainSpecifiers.some(({ value }) => isModuleSpecifier(value, 'teleproto'))) {
  throw new Error('[built-output] out/main/index.js does not reference teleproto')
}

console.log(`[built-output] verified ${outputFiles.length} JavaScript files and teleproto module provenance`)
