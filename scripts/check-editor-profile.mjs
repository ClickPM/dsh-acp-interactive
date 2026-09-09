/** Audit the curated editor profile and reconcile it with an official checkout. */

import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compositionPackages,
  diffSnapshot,
  discoverHumanCommands,
  officialSnapshot,
  owningPackage,
} from './profile-audit-lib.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'config/editor-profile.json'), 'utf8'))
const packageManifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'))
const localPackages = compositionPackages(await readFile(resolve(repositoryRoot, 'config/cordis.yml'), 'utf8'))

const errors = []
compare('editor composition', manifest.localCompositionPackages, localPackages)

for (const name of localPackages) {
  if (packageManifest.dependencies?.[owningPackage(name)] === undefined) {
    errors.push(`runtime dependency missing for bare plugin ${name}`)
  }
}
for (const selection of manifest.selections) {
  for (const name of selection.requiredPackages) {
    if (packageManifest.dependencies?.[name] === undefined) {
      errors.push(`${selection.id} requires undeclared runtime package ${name}`)
    }
  }
}
for (const deferred of manifest.deferred) {
  for (const name of deferred.excludedCompositionPackages) {
    if (localPackages.includes(name)) errors.push(`${deferred.id} is deferred but composes ${name}`)
  }
}

const harnessRoot = resolve(process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, '..', 'deepseek-harness'))
try {
  if (!(await stat(harnessRoot)).isDirectory()) throw new Error('not a directory')
} catch {
  errors.push(`official Harness checkout not found at ${harnessRoot}; set DSH_HARNESS_ROOT`)
}

if (errors.length === 0) {
  const officialPackages = new Set()
  for (const relativePath of manifest.reconciliation.referenceFiles) {
    const source = await readFile(resolve(harnessRoot, relativePath), 'utf8')
    for (const name of compositionPackages(source)) officialPackages.add(name)
  }
  const packages = [...officialPackages].sort()
  const commandEntries = await discoverHumanCommands(harnessRoot, packages)
  const observed = officialSnapshot(packages, commandEntries, manifest.reconciliation)
  for (const key of ['candidatePackages', 'humanCommands', 'requiredProviders', 'criticalConsumers']) {
    compare(`official ${key}`, manifest.reconciliation.snapshot[key], observed[key])
  }
}

if (errors.length > 0) {
  console.error('Editor profile audit found review-required drift:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.error(`Editor profile audit passed: ${localPackages.length} composed plugins, ${manifest.selections.length} reviewed capabilities.`)
}

function compare(label, expected, actual) {
  const difference = diffSnapshot(expected, actual)
  if (difference.added.length > 0) errors.push(`${label} added: ${difference.added.join(', ')}`)
  if (difference.removed.length > 0) errors.push(`${label} removed: ${difference.removed.join(', ')}`)
}
