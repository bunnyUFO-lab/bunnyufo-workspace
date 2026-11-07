// Pictures of a card, for the viewer's Copy image and Ask in chat. A card picture is read from this app's own
// origin (the viewer builds that address itself), so a canvas drawn from it is never tainted.

export const UNSUPPORTED = "Copying images isn't supported here. Use Download."

/** Why a copy did not happen. The viewer shows its message with a Download button. */
export class CopyError extends Error {
  constructor(message = UNSUPPORTED) { super(message); this.name = 'CopyError' }
}

const SVG_EDGE = 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The picture's bytes. */
export async function fetchCardImage(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`The picture could not be read (${response.status}).`)
  return response.blob()
}

const isSvg = (blob: Blob, name = '') => /svg/i.test(blob.type) || /\.svg(?:$|[?#])/i.test(name)

async function isPng(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer())
  return head.length === 8 && PNG_SIGNATURE.every((byte, index) => head[index] === byte)
}

/** The size an SVG draws at: its width and height, else the other one by its viewBox, else the viewBox's shape with a long edge of 1024. */
export function svgSize(text: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const attribute = (name: string) => new RegExp(String.raw`\s${name}\s*=\s*["']([^"']+)["']`, 'i').exec(root)?.[1]
  const length = (value?: string) => { const n = value && !value.includes('%') ? parseFloat(value) : NaN; return n > 0 ? n : 0 }
  const w = length(attribute('width')), h = length(attribute('height'))
  if (w && h) return { width: Math.round(w), height: Math.round(h) }
  const box = attribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  const ratio = box && box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : 1
  if (w) return { width: Math.round(w), height: Math.max(1, Math.round(w / ratio)) }
  if (h) return { width: Math.max(1, Math.round(h * ratio)), height: Math.round(h) }
  return ratio >= 1 ? { width: SVG_EDGE, height: Math.max(1, Math.round(SVG_EDGE / ratio)) } : { width: Math.max(1, Math.round(SVG_EDGE * ratio)), height: SVG_EDGE }
}

async function drawable(blob: Blob, name?: string): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (isSvg(blob, name)) {
    const { width, height } = svgSize(await blob.text())
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: 'image/svg+xml' }))
    const image = new Image()
    image.width = width; image.height = height
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('This picture could not be read.')); image.src = url })
    return { source: image, width, height, done: () => URL.revokeObjectURL(url) }
  }
  const bitmap = await createImageBitmap(blob)
  return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() }
}

/** PNG for the clipboard. A real PNG passes through unchanged; anything else is drawn on a canvas (a GIF gives its first frame). */
export async function toPng(blob: Blob, name?: string): Promise<Blob> {
  if (await isPng(blob)) return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' })
  const picture = await drawable(blob, name)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = picture.width; canvas.height = picture.height
    const context = canvas.getContext('2d')
    if (!context) throw new CopyError()
    context.drawImage(picture.source, 0, 0, picture.width, picture.height)
    // A canvas that is too big (iOS answers null), or tainted by an SVG foreignObject (SecurityError), cannot be copied.
    const made = await new Promise<Blob | null>((resolve, reject) => { try { canvas.toBlob(resolve, 'image/png') } catch (problem) { reject(problem) } })
    if (!made) throw new CopyError()
    return made
  } catch (problem) {
    throw problem instanceof CopyError ? problem : new CopyError()
  } finally {
    picture.done()
  }
}

/**
 * Put the picture on the clipboard as PNG. The ClipboardItem holds a promise made here, inside the click, because Safari
 * refuses a write that waits first. Rejects with CopyError (whose message says to use Download) whenever it cannot.
 */
export function copyImage(url: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return Promise.reject(new CopyError())
  try {
    const png = fetchCardImage(url).then(blob => toPng(blob, url))
    png.catch(() => {})
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch(() => { throw new CopyError() })
  } catch { return Promise.reject(new CopyError()) }
}

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** The picture as a file for a chat tray. An SVG becomes a PNG, since the chat takes raster pictures only. */
export async function toPictureFile(blob: Blob, name: string): Promise<File> {
  if (isSvg(blob, name)) {
    const png = await toPng(blob, name)
    return new File([png], name.replace(/\.svg$/i, '') + '.png', { type: 'image/png' })
  }
  const type = /^image\//.test(blob.type) ? blob.type : TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? blob.type
  return new File([blob], name, { type })
}

/** The line a new chat starts with: where the picture came from. The title is one line of at most 80 characters, then room to type. */
export function askDraft(title: string, file: string, origin: string, workspace: string, card: string): string {
  const line = title.replace(/\s+/g, ' ').trim().slice(0, 80)
  return `From card "${line}" (${file}): ${origin}/${encodeURIComponent(workspace)}#/${encodeURIComponent(card)}\n\n`
}
