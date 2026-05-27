#!/usr/bin/env node
import { createWriteStream } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const root = path.dirname(fileURLToPath(import.meta.url))
const bin = path.join(root, "bin")
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))

if (process.env.MEGCODE_SKIP_DOWNLOAD === "1") {
  console.log("Skipping megcode binary download")
  process.exit(0)
}

const repo = process.env.MEGCODE_REPO || "meglinge/opencode"
const version = process.env.MEGCODE_VERSION || pkg.version
const tag = process.env.MEGCODE_TAG || `v${version}`
const asset = assetName()
const url = `https://github.com/${repo}/releases/download/${tag}/${asset}`
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "megcode-"))
const archive = path.join(tmp, asset)
const extractDir = path.join(tmp, "extract")

try {
  await fs.mkdir(extractDir, { recursive: true })
  await download(url, archive)
  await extract(archive, extractDir)
  await installBinary(extractDir)
  console.log(`Installed megcode ${version}`)
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}

function assetName() {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const arch = process.arch
  if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`)
  if (!["darwin", "linux", "windows"].includes(platform)) throw new Error(`Unsupported platform: ${process.platform}`)

  const baseline = arch === "x64" && process.env.MEGCODE_BASELINE === "1" ? "-baseline" : ""
  const libc = platform === "linux" && isMusl() ? "-musl" : ""
  return platform === "linux"
    ? `opencode-${platform}-${arch}${baseline}${libc}.tar.gz`
    : `opencode-${platform}-${arch}${baseline}.zip`
}

function isMusl() {
  if (process.env.MEGCODE_LIBC === "musl") return true
  if (process.env.MEGCODE_LIBC === "glibc") return false
  return process.report?.getReport().header.glibcVersionRuntime === undefined
}

async function download(input, output) {
  const response = await fetch(input, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`Failed to download ${input}: ${response.status} ${response.statusText}`)
  await pipeline(response.body, createWriteStream(output))
}

async function extract(input, output) {
  if (input.endsWith(".tar.gz")) {
    execFileSync("tar", ["-xzf", input, "-C", output], { stdio: "inherit" })
    return
  }
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", input, "-DestinationPath", output], {
      stdio: "inherit",
    })
    return
  }
  execFileSync("unzip", ["-q", input, "-d", output], { stdio: "inherit" })
}

async function installBinary(input) {
  const source = path.join(input, process.platform === "win32" ? "opencode.exe" : "opencode")
  const target = path.join(bin, process.platform === "win32" ? "megcode.exe" : "megcode")
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
}
