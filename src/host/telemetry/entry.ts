// CLI entry for the package uninstall hook. Bundled to lib/telemetry-entry.js
// and launched detached by scripts/telemetry-entry.mjs so that package removal
// never waits on telemetry. Unknown arguments and every failure are silently
// ignored: telemetry must never fail uninstall.
import {
  captureTelemetry,
  readBundledBuildInfo,
  telemetryEndpointFor
} from './product-telemetry.ts'

const event = process.argv[3]
if (process.argv[2] === 'capture' && event === 'dsh_plugin_uninstall_hook') {
  try {
    const buildInfo = readBundledBuildInfo()
    await captureTelemetry({
      buildInfo,
      endpoint: telemetryEndpointFor({ buildInfo }),
      event,
      source: 'uninstall-hook'
    })
  } catch {
    // Telemetry must never affect uninstall.
  }
}
