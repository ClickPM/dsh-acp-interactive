/** Run the current official Harness ACP tests against this repository's source. */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessRoot = resolve(process.env.DSH_HARNESS_ROOT ?? resolve(repositoryRoot, '..', 'deepseek-harness'))
const officialTests = resolve(harnessRoot, 'packages', 'acp', 'acp-interactive', 'tests')
const stagedTests = resolve(repositoryRoot, '.harness-tests')

async function assertDirectory(path, label) {
  try {
    if ((await stat(path)).isDirectory()) return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  throw new Error(`${label} not found at ${path}; set DSH_HARNESS_ROOT to a DeepSeek Harness checkout`)
}

async function stageDirectory(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name)
    const targetPath = resolve(target, entry.name)
    if (entry.isDirectory()) await stageDirectory(sourcePath, targetPath)
    else if (entry.isFile()) await copyFile(sourcePath, targetPath)
  }
}

function runVitest() {
  const executable = resolve(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs')
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [executable, 'run', '--config', 'vitest.harness.config.ts'], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`official Harness tests terminated by ${signal}`))
      else resolveRun(code ?? 1)
    })
  })
}

await assertDirectory(officialTests, 'official ACP test directory')
await rm(stagedTests, { recursive: true, force: true })
try {
  await stageDirectory(officialTests, stagedTests)
  console.error(`Running official ACP tests from ${officialTests}`)
  process.exitCode = await runVitest()
} finally {
  await rm(stagedTests, { recursive: true, force: true })
}
