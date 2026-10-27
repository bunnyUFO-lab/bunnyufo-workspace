// Shared GPU logic for the 24 GB GPU that ComfyUI (Sprite Studio's jobs) and local Ollama models share.
// Sprite Studio's own MCP server (http://localhost:8190/mcp, in the ComfyUI repo) is how agents use the app, and the
// ComfyUI repo's comfy.py runs its raw workflows; this module only decides who gets the GPU and records finished
// Sprite Studio jobs in the Pixel Art Studio gallery.
// Used by: tools/gpu/mcp.mjs (gpu_status / free_gpu) and tools/gpu/claude-hook.mjs (a Claude Code hook you
// can register in your own settings). Plain Node / Bun, no dependencies.
//
// Settings (environment or the workspace .env): SPRITE_STUDIO_URL, COMFY_URL, OLLAMA_URL, GALLERY_DIR,
// SPRITE_STUDIO_SHARE_MAX_GB (local models up to this size stay loaded during light jobs; 0 = always unload).
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCard } from '../../server/workspaces.mjs'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function loadDotenv() {
  const file = path.join(ROOT, '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match && match[2] && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
}
loadDotenv()

const env = (name, fallback) => (process.env[name] || fallback).replace(/\/$/, '')
export const STUDIO = env('SPRITE_STUDIO_URL', 'http://127.0.0.1:8190')
export const COMFY = env('COMFY_URL', 'http://127.0.0.1:8188')
export const OLLAMA = env('OLLAMA_URL', 'http://127.0.0.1:11434')
export const SHARE_MAX_GB = Number(process.env.SPRITE_STUDIO_SHARE_MAX_GB ?? 12)
// Where finished jobs are copied: GALLERY_DIR (a folder, or "off"), else the gallery folder of the
// Pixel Art Studio card in whichever registered workspace holds it (see server/workspaces.mjs).
export async function galleryDir() {
  const setting = process.env.GALLERY_DIR
  if (setting) return setting.toLowerCase() === 'off' ? null : path.resolve(ROOT, setting)
  const found = await findCard({ appRepo: ROOT, id: 'pixel-art-studio' }).catch(() => null)
  return found ? path.join(found.folder, 'gallery') : null
}
const GB = 2 ** 30
const ENOUGH_FREE_VRAM = 20 * GB

// Sprite Studio MCP tools by GPU weight (see webapp/app/routes_mcp.py in the ComfyUI repo).
// Light tools run the 8-bit Z-Image workflow (~12 GB) and leave room for a local model up to SHARE_MAX_GB.
const LIGHT = new Set(['generate_drafts', 'generate_sprite', 'make_sprite', 'generate_tiles'])
// Wan 2.2 VACE (AI Animate, pose matching) is as heavy as animate: two 14B models.
const HEAVY = new Set(['edit', 'make_directions', 'animate', 'extend', 'resize', 'ai_animate', 'match_pose', 'animate_between'])
export const GENERATION_TOOLS = new Set([...LIGHT, ...HEAVY])
export const JOB_TOOLS = new Set(['wait_for_job', 'job_status'])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const getJson = async (url, timeout = 5000) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`)
  return response.json()
}
const postJson = (url, body, timeout = 30000) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
})

/** "mcp__sprite-studio__animate" (Claude) or "sprite-studio_animate" (OpenCode) -> "animate"; null for other servers. */
export function spriteStudioTool(name = '') {
  const match = String(name).match(/^(?:mcp__sprite-studio__|sprite-studio_)(.+)$/)
  return match ? match[1] : null
}

/** "heavy", "light" or "none" for a Sprite Studio tool call. */
export function weight(tool, args = {}) {
  if (LIGHT.has(tool)) return 'light'
  if (tool === 'resize') return ['repixel', 'double'].includes(args.how) ? 'none' : 'heavy'
  if (HEAVY.has(tool)) return 'heavy'
  return 'none'
}

// ----------------------------------------------------------------- Ollama
export async function ollamaModels() {
  try { return (await getJson(`${OLLAMA}/api/ps`)).models ?? [] } catch { return null }
}

/** Unload Ollama models that do not fit beside ComfyUI (all of them with everything=true). Returns their names. */
export async function unloadOllama({ everything = false } = {}) {
  const models = (await ollamaModels()) ?? []
  const names = models.filter(m => everything || (m.size_vram ?? 0) > SHARE_MAX_GB * GB).map(m => m.name)
  for (const name of names) {
    try { await postJson(`${OLLAMA}/api/generate`, { model: name, keep_alive: 0 }) } catch { /* already gone */ }
  }
  for (let attempt = 0; attempt < 20 && names.length; attempt++) {
    const still = ((await ollamaModels()) ?? []).filter(m => names.includes(m.name))
    if (!still.length) break
    await sleep(500)
  }
  return names
}

/** Before a Sprite Studio tool runs: make room on the GPU for its job. Returns a note or null. */
export async function beforeSpriteStudioTool(tool, args = {}) {
  const w = weight(tool, args)
  if (w === 'none') return null
  const unloaded = await unloadOllama({ everything: w === 'heavy' })
  return unloaded.length ? `Unloaded local model(s) ${unloaded.join(', ')} to give ComfyUI the GPU.` : null
}

// ----------------------------------------------------------------- Raw ComfyUI workflows
// The ComfyUI repo's own comfy.py runs its workflows (comfyui-workflows skill). Video workflows such as
// wan22-svi-extend need the whole GPU, so a run unloads every local model first.

/** True for a shell command that queues a workflow with the ComfyUI repo's comfy.py ("python …/comfy.py run …"). */
export const isComfyRun = command => /\bcomfy\.py["']?\s+(?:--server[\s=]\S+\s+)?run\b/.test(String(command ?? ''))

/** Before a comfy.py run: give ComfyUI the whole GPU. Returns a note or null. */
export async function beforeComfyRun() {
  const unloaded = await unloadOllama({ everything: true })
  return unloaded.length ? `Unloaded local model(s) ${unloaded.join(', ')} for a ComfyUI workflow.` : null
}

// ----------------------------------------------------------------- ComfyUI
export async function comfyBusy() {
  try {
    const queue = await getJson(`${COMFY}/queue`)
    return Boolean(queue.queue_running?.length || queue.queue_pending?.length)
  } catch { return false }
}

export const comfyFreeVram = async () => (await getJson(`${COMFY}/system_stats`)).devices?.[0]?.vram_free ?? 0

/** Unload ComfyUI's models and caches (VRAM and RAM). Returns {before, after} free VRAM, or null when busy/down. */
export async function freeComfy({ force = false } = {}) {
  try {
    if (await comfyBusy()) return null
    const before = await comfyFreeVram()
    if (!force && before >= ENOUGH_FREE_VRAM) return { before, after: before }
    await postJson(`${COMFY}/free`, { unload_models: true, free_memory: true })
    let after = before
    for (let attempt = 0; attempt < 20 && after < ENOUGH_FREE_VRAM; attempt++) {
      await sleep(500)
      after = await comfyFreeVram()
    }
    return { before, after }
  } catch { return null }
}

/** Who holds the GPU right now. */
export async function gpuStatus() {
  const status = { comfyui: 'not reachable', ollama: 'not running', settings: { share_max_gb: SHARE_MAX_GB, gallery: Boolean(await galleryDir()) } }
  try {
    const device = (await getJson(`${COMFY}/system_stats`)).devices[0]
    const queue = await getJson(`${COMFY}/queue`)
    status.comfyui = { gpu_free_gb: +(device.vram_free / GB).toFixed(1), gpu_total_gb: +(device.vram_total / GB).toFixed(1),
      running: queue.queue_running?.length ?? 0, pending: queue.queue_pending?.length ?? 0 }
  } catch { /* down */ }
  const models = await ollamaModels()
  if (models) status.ollama = models.map(m => ({ name: m.name, vram_gb: +((m.size_vram ?? 0) / GB).toFixed(1),
    on_gpu: `${Math.round(100 * (m.size_vram ?? 0) / Math.max(m.size ?? 1, 1))}%` }))
  return status
}

// ----------------------------------------------------------------- jobs and the gallery
export async function job(jobId) {
  return getJson(`${STUDIO}/api/jobs/${encodeURIComponent(jobId)}`)
}

export const unfinished = async jobId => {
  try { return ['queued', 'running'].includes((await job(jobId)).status) } catch { return false }
}

export const jobIdsIn = text => [...new Set(String(text ?? '').match(/\bjob_[0-9a-f]{6,}\b/g) ?? [])]

async function readGallery(gallery) {
  try { return JSON.parse(await readFile(path.join(gallery, 'gallery.json'), 'utf8')) } catch { return { entries: [] } }
}

async function writeGallery(gallery, data) {
  await mkdir(gallery, { recursive: true })
  const temporary = path.join(gallery, 'gallery.json.tmp')
  await writeFile(temporary, JSON.stringify(data, null, 1))
  await rename(temporary, path.join(gallery, 'gallery.json'))
}

const absolute = url => (url.startsWith('http') ? url : STUDIO + url)

/** Copy a finished job's visible results into the Pixel Art Studio gallery (idempotent). Returns true when added. */
export async function recordGallery(jobId) {
  if (!jobId) return false
  const GALLERY = await galleryDir()
  if (!GALLERY) return false
  const finished = await job(jobId)
  if (finished.status !== 'done') return false
  const data = await readGallery(GALLERY)
  if (data.entries.some(entry => entry.job_id === jobId)) return false
  const params = finished.params ?? {}
  const entry = {
    job_id: jobId, op: finished.op, title: finished.title, prompt: params.prompt,
    params: Object.fromEntries(Object.entries(params).filter(([key]) =>
      ['view', 'pixels', 'colors', 'palette', 'style_id', 'lora', 'seed', 'tile_size', 'motion', 'frames', 'fps', 'asset'].includes(key))),
    created: new Date((finished.finished ?? Date.now() / 1000) * 1000).toISOString().slice(0, 19), assets: [],
  }
  for (const assetId of finished.outputs ?? []) {
    let asset
    try { asset = await getJson(`${STUDIO}/api/assets/${assetId}`) } catch { continue }
    if (asset.hidden) continue
    const files = asset.files ?? {}
    let url = asset.url
    if (!['sprite', 'tile'].includes(asset.kind)) url = files['preview.gif'] ?? files['thumb.png'] ?? asset.url
    const extension = path.extname(url.split('?')[0]) || '.png'
    const relative = `${jobId}/${asset.id}${extension}`
    try {
      const response = await fetch(absolute(url), { signal: AbortSignal.timeout(30000) })
      if (!response.ok) continue
      await mkdir(path.join(GALLERY, jobId), { recursive: true })
      await writeFile(path.join(GALLERY, relative), Buffer.from(await response.arrayBuffer()))
    } catch { continue }
    const meta = asset.meta ?? {}
    entry.assets.push({ id: asset.id, kind: asset.kind, title: asset.title, status: asset.status, file: relative,
      w: meta.w, h: meta.h, palette: meta.palette })
  }
  if (!entry.assets.length) {
    await rm(path.join(GALLERY, jobId), { recursive: true, force: true })
    return false
  }
  data.entries.unshift(entry)
  await writeGallery(GALLERY, data)
  return true
}
