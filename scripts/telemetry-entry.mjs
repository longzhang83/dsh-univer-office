// Package uninstall lifecycle entry. It must never fail or slow removal: if the
// bundled telemetry entry is missing (fresh checkout before a build, scripts
// disabled) it exits silently, and otherwise the send runs in a detached child
// process. The published package intentionally declares no postinstall script
// because DSH profiles reject unapproved dependency build scripts.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const command = process.argv[2]
const eventByCommand = {
  uninstall: 'dsh_plugin_uninstall_hook'
}
const event = command === undefined ? undefined : eventByCommand[command]
const entry = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  'lib',
  'telemetry-entry.js'
)

if (event !== undefined && existsSync(entry)) {
  spawn(process.execPath, [entry, 'capture', event], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()
}
