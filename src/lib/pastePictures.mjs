// Picking pictures out of a paste or a drop. Pure: no React, no DOM beyond the transfer object it is given.

const isImage = file => !!file && typeof file.type === 'string' && file.type.startsWith('image/')

/** The image files in a clipboard or drag transfer, from `files` and `items`, each once, in the order they came. */
export function pictureFiles(transfer) {
  if (!transfer) return []
  const found = []
  const seen = new Set()
  const take = file => {
    if (!isImage(file)) return
    const key = `${file.name}|${file.type}|${file.size}`
    if (seen.has(key)) return
    seen.add(key)
    found.push(file)
  }
  Array.from(transfer.files ?? []).forEach(take)
  Array.from(transfer.items ?? []).forEach(item => { if (item && item.kind === 'file') take(item.getAsFile()) })
  return found
}

/** Whether a drag carries files at all (a picture or not). */
export function hasFiles(transfer) {
  return !!transfer && Array.from(transfer.types ?? []).includes('Files')
}

/** Whether a clipboard carries plain text. */
export function hasText(transfer) {
  return !!transfer && Array.from(transfer.types ?? []).includes('text/plain')
}

/** Whether an event target takes typed text: an input, a textarea or a contenteditable element. */
export function isTextField(target) {
  if (!target || typeof target !== 'object') return false
  const name = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
  if (name === 'textarea') return true
  if (name === 'input') {
    const type = String(target.type ?? 'text').toLowerCase()
    return !['button', 'checkbox', 'radio', 'file', 'submit', 'reset', 'image', 'range', 'color'].includes(type)
  }
  return target.isContentEditable === true || target.contentEditable === 'true' || (typeof target.getAttribute === 'function' && ['', 'true', 'plaintext-only'].includes(target.getAttribute('contenteditable') ?? 'no'))
}
