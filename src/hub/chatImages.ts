// Pictures for a Hub Chat message: decode in the browser, scale, re-encode through a canvas (which
// drops EXIF, GPS included), and turn into base64 for the message body.
export const MAX_IMAGES = 4
const LONG_EDGE = 1568
const PNG_KEEP = 1.5 * 1024 * 1024
const MAX_BYTES = 1.5 * 1024 * 1024

export interface Prepared { id: number; blob: Blob; type: 'image/jpeg' | 'image/png'; width: number; height: number; url: string }

export const CANNOT_OPEN = "This picture can't be opened here. Try a JPEG or PNG."

let counter = 0

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality))

/** Decode, scale to at most 1568 px on the long edge, and re-encode: PNG stays PNG when small, the rest is JPEG. */
export async function prepareImage(file: File): Promise<Prepared> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error(CANNOT_OPEN)
  }
  try {
    const scale = Math.min(1, LONG_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error(CANNOT_OPEN)
    let blob: Blob | null = null
    let type: Prepared['type'] = 'image/jpeg'
    if (file.type === 'image/png') {
      context.drawImage(bitmap, 0, 0, width, height)
      const png = await toBlob(canvas, 'image/png')
      if (png && png.size <= PNG_KEEP) { blob = png; type = 'image/png' }
    }
    if (!blob) {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, width, height)
      context.drawImage(bitmap, 0, 0, width, height)
      for (const quality of [0.85, 0.7, 0.5]) {
        blob = await toBlob(canvas, 'image/jpeg', quality)
        if (blob && blob.size <= MAX_BYTES) break
      }
    }
    if (!blob) throw new Error(CANNOT_OPEN)
    if (blob.size > MAX_BYTES) throw new Error('This picture is too big to send.')
    counter += 1
    return { id: counter, blob, type, width, height, url: URL.createObjectURL(blob) }
  } finally {
    bitmap.close()
  }
}

/** The bytes of a blob as base64, without the data-URL head. */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let text = ''
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}
