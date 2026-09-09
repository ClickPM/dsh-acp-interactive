/** Shared editor-profile audit helpers. */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'

const DSH_PACKAGE = /^@deepseek-ai\/dsh-/u

/** Parse a Cordis document and return every bare published plugin row. */
export function compositionPackages(source) {
  const document = parse(source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
  })
  const packages = new Set()
  visit(document, value => {
    if (typeof value?.name === 'string' && DSH_PACKAGE.test(value.name)) packages.add(value.name)
  })
  return [...packages].sort()
}

function visit(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback)
    return
  }
  if (value === null || typeof value !== 'object') return
  callback(value)
  for (const child of Object.values(value)) visit(child, callback)
}

/**
 * Reduce a bare plugin specifier to the package that must be installed for it.
 * A subpath companion such as `@deepseek-ai/dsh-agent/invariant` ships inside its
 * own package, so the dependency to declare and resolve is `@deepseek-ai/dsh-agent`.
 */
export function owningPackage(name) {
  const segments = name.split('/')
  return name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/** Return stable additions/removals between one frozen snapshot and observation. */
export function diffSnapshot(expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    added: [...actualSet].filter(value => !expectedSet.has(value)).sort(),
    removed: [...expectedSet].filter(value => !actualSet.has(value)).sort(),
  }
}

/** Classify the official composition using the manifest's review boundary. */
export function officialSnapshot(packages, commandEntries, reconciliation) {
  const candidates = packages.filter(name => reconciliation.candidatePatterns
    .some(pattern => new RegExp(pattern, 'u').test(name)))
  return {
    candidatePackages: candidates,
    humanCommands: [...new Set(commandEntries.map(entry => entry.command))].sort(),
    requiredProviders: candidates.filter(name => reconciliation.providerPatterns
      .some(pattern => new RegExp(pattern, 'u').test(name))),
    criticalConsumers: candidates.filter(name => reconciliation.consumerPatterns
      .some(pattern => new RegExp(pattern, 'u').test(name))),
  }
}

/** Discover literal ctx.commands.register names from composed official packages. */
export async function discoverHumanCommands(harnessRoot, composedPackages) {
  const packageDirs = await packageDirectoryIndex(join(harnessRoot, 'packages'))
  const entries = []
  for (const packageName of composedPackages) {
    const directory = packageDirs.get(packageName)
    if (directory === undefined) continue
    const sourceRoot = join(directory, 'src')
    for (const path of await filesUnder(sourceRoot, '.ts')) {
      const source = await readFile(path, 'utf8')
      const registration = /commands\.register\s*\(\s*\{[\s\S]{0,800}?\bname:\s*['"]([^'"]+)['"]/gu
      for (const match of source.matchAll(registration)) {
        entries.push({ package: packageName, command: match[1] })
      }
    }
  }
  return entries.sort((left, right) => left.command.localeCompare(right.command)
    || left.package.localeCompare(right.package))
}

async function packageDirectoryIndex(root) {
  const index = new Map()
  for (const path of await filesUnder(root, 'package.json')) {
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (typeof manifest.name === 'string') index.set(manifest.name, join(path, '..'))
  }
  return index
}

async function filesUnder(root, suffix) {
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...await filesUnder(path, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path)
  }
  return found
}
