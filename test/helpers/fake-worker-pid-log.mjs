/**
 * Spawn log shared by the pool tests and the fake worker fixture.
 *
 * The fake worker appends its pid here on start; the tests truncate it and
 * read it back. A child process cannot inherit a custom path through the pool
 * (the pool filters the child environment down to a fixed allowlist), so the
 * path is a constant instead.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PID_LOG = join(tmpdir(), 'dsh-univer-fake-worker-pids.log')

/** Drop every recorded pid. */
export async function resetPidLog() {
  await writeFile(PID_LOG, '')
}

/** Every pid recorded so far, in spawn order. */
export async function readPids() {
  const raw = await readFile(PID_LOG, 'utf8').catch(() => '')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(Number)
}

/** Wait until `count` pids are recorded; the fake writes on its first tick. */
export async function waitForPids(count, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  let pids = await readPids()
  while (pids.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    pids = await readPids()
  }
  return pids
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Whether a pid is still running. */
export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait for a pid to be reaped; returns false if it never is. */
export async function waitUntilDead(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(15)
  }
  return false
}
