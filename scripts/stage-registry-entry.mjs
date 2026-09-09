/**
 * Copy registry/agent.json and icon.svg into a checkout of
 * agentclientprotocol/registry so its own validator scripts can run against
 * this repository's entry. An optional --version replaces the published
 * version in both the manifest and the npx package spec.
 */

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const registryRoot = args.find(argument => !argument.startsWith('--'))
if (registryRoot === undefined) {
  console.error('usage: node scripts/stage-registry-entry.mjs <registry-checkout> [--version <x.y.z>]')
  process.exit(2)
}
const versionIndex = args.indexOf('--version')
const versionOverride = versionIndex >= 0 ? args[versionIndex + 1]?.replace(/^v/, '') : undefined

const entry = JSON.parse(await readFile(join(repositoryRoot, 'registry/agent.json'), 'utf8'))
if (versionOverride !== undefined && versionOverride !== '') {
  if (!/^\d+\.\d+\.\d+$/.test(versionOverride)) {
    console.error(`--version ${versionOverride} is not x.y.z`)
    process.exit(2)
  }
  const packageName = entry.distribution.npx.package.replace(/@[^@]+$/, '')
  entry.version = versionOverride
  entry.distribution.npx.package = `${packageName}@${versionOverride}`
}

const target = join(resolve(registryRoot), entry.id)
await mkdir(target, { recursive: true })
await writeFile(join(target, 'agent.json'), `${JSON.stringify(entry, null, 2)}\n`)
await copyFile(join(repositoryRoot, 'icon.svg'), join(target, 'icon.svg'))
console.error(`Staged ${entry.id} ${entry.version} into ${target}`)
