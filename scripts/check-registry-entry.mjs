/** Check registry/agent.json and icon.svg against package.json and the ACP Registry rules. */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'))
const entry = JSON.parse(await readFile(resolve(repositoryRoot, 'registry/agent.json'), 'utf8'))
const icon = await readFile(resolve(repositoryRoot, 'icon.svg'), 'utf8')

const errors = []

// Mirrors the id rules enforced by build_registry.py in agentclientprotocol/registry.
if (!/^[a-z][a-z0-9-]*$/.test(entry.id)) errors.push(`id ${JSON.stringify(entry.id)} must be lowercase letters, digits, and hyphens, starting with a letter`)
if (!/^\d+\.\d+\.\d+$/.test(entry.version)) errors.push(`version ${JSON.stringify(entry.version)} is not x.y.z`)
for (const field of ['name', 'description', 'license_url', 'distribution']) {
  if (entry[field] === undefined) errors.push(`missing required field ${field}`)
}

const expectedPackage = `${manifest.name}@${entry.version}`
if (entry.distribution?.npx?.package !== expectedPackage) {
  errors.push(`distribution.npx.package must be ${expectedPackage}, found ${entry.distribution?.npx?.package}`)
}

const repositoryUrl = manifest.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '')
if (entry.repository !== repositoryUrl) errors.push(`repository must match package.json (${repositoryUrl})`)
if (entry.license !== manifest.license) errors.push(`license must match package.json (${manifest.license})`)
if (!entry.license_url?.startsWith(`${repositoryUrl}/`)) errors.push('license_url must point into the repository')

// Mirrors the icon rules: 16x16 and monochrome via currentColor/none only.
const sixteen = /\bwidth="16"\s+height="16"/.test(icon) || /viewBox="0 0 16 16"/.test(icon)
if (!sixteen) errors.push('icon.svg must declare width/height 16 or viewBox="0 0 16 16"')
for (const match of icon.matchAll(/\b(fill|stroke)="([^"]*)"/g)) {
  if (!['currentColor', 'none'].includes(match[2])) errors.push(`icon.svg ${match[1]}="${match[2]}" must be currentColor or none`)
}
if (/style=|<linearGradient|<radialGradient/.test(icon)) errors.push('icon.svg must not use inline styles or gradients')

if (errors.length > 0) {
  console.error('Registry entry check failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.error(`Registry entry check passed: ${entry.id} -> ${expectedPackage}`)
}
