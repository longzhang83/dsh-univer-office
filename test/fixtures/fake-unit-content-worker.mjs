/**
 * Stand-in for the bundled `unit-content-worker.mjs`, speaking the exact
 * process protocol the Host expects: one JSON request per stdin line, one JSON
 * envelope per stdout line.
 *
 * The real worker needs the built bundle plus Univer's native bindings, neither
 * of which exists in this worktree, so the pool is exercised against this
 * script instead. Behaviour is selected per request through `unitId`:
 *
 * - `ok` (default): answer `{ ok: true, result: { pid, unitId } }`
 * - `slow:<ms>`: answer after `<ms>` milliseconds
 * - `hang`: never answer (lets the operation timeout fire)
 * - `crash`: `process.exit(3)` without answering
 * - `garbage`: write a line that is not a valid envelope
 * - `error`: answer `{ ok: false, error: { code, message } }`
 *
 * Every start appends its pid to a fixed log so tests can prove reuse,
 * replacement, and the absence of orphan processes.
 */
import { appendFileSync } from 'node:fs'
import { PID_LOG } from '../helpers/fake-worker-pid-log.mjs'

appendFileSync(PID_LOG, `${String(process.pid)}\n`)

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  drain()
})
process.stdin.on('end', () => {
  if (buffer.trim().length > 0) handle(buffer)
  buffer = ''
})

function drain() {
  let newline = buffer.indexOf('\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.trim().length > 0) handle(line)
    newline = buffer.indexOf('\n')
  }
}

function handle(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const mode = typeof request?.unitId === 'string' ? request.unitId : 'ok'
  if (mode === 'crash') process.exit(3)
  if (mode === 'hang') return
  if (mode === 'garbage') {
    process.stdout.write('not-an-envelope\n')
    return
  }
  if (mode === 'error') {
    write({ ok: false, error: { code: 'UNIT_CONTENT_WORKER_FAILED', message: 'fake failure' } })
    return
  }
  if (mode.startsWith('slow:')) {
    setTimeout(() => write(result(request)), Number(mode.slice('slow:'.length)))
    return
  }
  write(result(request))
}

function result(request) {
  return { ok: true, result: { pid: process.pid, unitId: request?.unitId ?? null } }
}

function write(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
}
