/**
 * Run the pinned official Harness ACP specs against this repository's source.
 *
 * The baseline is a git ref recorded in `config/upstream-baseline.json`, and the
 * specs are extracted from that ref rather than read out of the checkout's
 * working tree, so the gate reports one reviewed upstream version instead of
 * whatever a developer happens to have checked out.
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, '..', 'deepseek-harness'))
const stagedTests = resolve(repositoryRoot, '.harness-tests')
const baseline = JSON.parse(
  await readFile(resolve(repositoryRoot, 'config/upstream-baseline.json'), 'utf8'),
)
// The scheduled latest-upstream observation overrides the pin; the blocking gate
// leaves it unset so the reviewed ref is the only thing it can report on.
const ref = process.env.DSH_HARNESS_REF ?? baseline.ref

/** Fail with a diagnostic that never reads as a pass. */
function unavailable(message) {
  throw new Error(`fixture unavailable: ${message}`)
}

function git(args) {
  const result = spawnSync('git', ['-C', harnessRoot, ...args], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  return result
}

/** Extract one ref's subtrees into the staging directory. */
function extract(paths) {
  const archive = spawnSync('git', ['-C', harnessRoot, 'archive', ref, ...paths], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (archive.error !== undefined) throw archive.error
  if (archive.status !== 0) {
    unavailable(`git archive ${ref} failed: ${archive.stderr.toString('utf8').trim()}`)
  }
  const untar = spawnSync('tar', ['-x', '-C', stagedTests], { input: archive.stdout })
  if (untar.error !== undefined) throw untar.error
  if (untar.status !== 0) unavailable(`could not unpack ${ref}: ${String(untar.stderr)}`)
}

function runVitest(specs) {
  const executable = resolve(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs')
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [executable, 'run', '--config', 'vitest.harness.config.ts', ...specs],
      { cwd: repositoryRoot, env: process.env, stdio: 'inherit', shell: false },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`official Harness tests terminated by ${signal}`))
      else resolveRun(code ?? 1)
    })
  })
}

if (git(['rev-parse', '--git-dir']).status !== 0) {
  unavailable(`no DeepSeek Harness git checkout at ${harnessRoot}; set DSH_HARNESS_ROOT to one`)
}
if (git(['rev-parse', '--verify', `${ref}^{commit}`]).status !== 0) {
  unavailable(`${harnessRoot} has no ref ${ref}; fetch the official tags to restore the pinned baseline`)
}

await rm(stagedTests, { recursive: true, force: true })
await mkdir(stagedTests, { recursive: true })
try {
  // Staged at their real monorepo-relative paths so cross-package fixture
  // imports keep resolving; vitest.harness.config.ts redirects the staged
  // package's own `../src` onto this repository's source.
  extract([baseline.acpTestPath, ...baseline.sharedFixturePaths ?? []])

  const stagedAcpTests = resolve(stagedTests, baseline.acpTestPath)
  let entries
  try {
    entries = await readdir(stagedAcpTests, { withFileTypes: true })
  } catch {
    unavailable(`${ref} has no ACP test directory at ${baseline.acpTestPath}`)
  }
  const official = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map(entry => entry.name)
    .sort()

  const aligned = new Map((baseline.alignedSpecs ?? []).map(spec => [spec.file, spec]))
  const divergent = new Map((baseline.divergentSpecs ?? []).map(spec => [spec.file, spec]))
  const unclassified = official.filter(file => !aligned.has(file) && !divergent.has(file))
  const missing = [...aligned.keys(), ...divergent.keys()].filter(file => !official.includes(file))

  console.error(`Pinned official ACP baseline ${ref} (${baseline.acpTestPath})`)
  for (const spec of divergent.values()) {
    if (!official.includes(spec.file)) continue
    console.error(`  recorded divergence  ${spec.file} [${spec.kind}] ${spec.reason}`)
  }
  if (missing.length > 0) {
    unavailable(
      `${ref} no longer publishes classified spec(s) ${missing.join(', ')}; `
      + 'update config/upstream-baseline.json under review',
    )
  }
  if (unclassified.length > 0) {
    unavailable(
      `${ref} publishes unclassified official spec(s) ${unclassified.join(', ')}; `
      + 'classify each in config/upstream-baseline.json as aligned or divergent under review',
    )
  }

  const specs = official
    .filter(file => aligned.has(file))
    .map(file => `${stagedTests.replaceAll('\\', '/')}/${baseline.acpTestPath}/${file}`)
  if (specs.length === 0) unavailable(`no aligned official spec remains at ${ref}`)
  console.error(`  running aligned      ${official.filter(file => aligned.has(file)).join(', ')}`)
  process.exitCode = await runVitest(specs)
} finally {
  await rm(stagedTests, { recursive: true, force: true })
}
