#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const executable = path.join(dir, process.platform === "win32" ? "megcode.exe" : "megcode")
const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" })

if (result.error) {
  console.error(`Failed to run megcode binary at ${executable}: ${result.error.message}`)
  process.exit(1)
}

if (result.signal) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)
