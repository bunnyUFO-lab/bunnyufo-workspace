import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, DragEvent } from 'react'
import { HubError } from '../lib/hub'
import { hasFiles, pictureFiles } from '../lib/pastePictures.mjs'
import { CANNOT_OPEN, isPicture, prepareImage } from './chatImages'
import type { Prepared } from './chatImages'

/** One picture in a tray: just prepared in this browser, saved on the server, or only named by a read of the server. */
export interface PictureItem {
  id: string
  /** What the tile shows: an object URL for a picture made here. Empty for a stored one (see `path`). */
  url: string
  /** The Hub file path of a stored picture, for its preview. */
  path?: string
  /** The name the server keeps it under, once it is stored. */
  file?: string
  prepared?: Prepared
  state: 'uploading' | 'ready' | 'failed'
  error?: string
}

export const SAVE_FAILED = "The picture didn't save. Check the connection, then tap Retry."

export interface PicturesOptions {
  /** Pictures allowed here. */
  max: number
  /** Used in the limit sentence: "An answer", "A step", "A message". */
  noun: string
  /** Saves a prepared picture on the server and returns the name it was kept under. Absent: pictures stay in this browser, as in Chat. */
  store?: (picture: Prepared) => Promise<string>
  /** Deletes a stored picture. */
  discard?: (file: string) => Promise<void>
  /** Pictures the server already holds, shown first. */
  stored?: string[]
  /** The Hub file path of a stored picture, for its preview. */
  pathOf?: (file: string) => string
  /** A reason adding is off, shown instead of adding. */
  locked?: string | null
}

/**
 * The pictures of one text box: picking, pasting and dropping, decoding and scaling in the browser, and, where `store` is given, saving each one on the
 * server as soon as it is picked. Chat and every inbox item use it with the same button and tray (PictureTray.tsx).
 */
export function usePictures(options: PicturesOptions) {
  const { stored = [], pathOf } = options
  const [local, setLocal] = useState<PictureItem[]>([])
  const [gone, setGone] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(0)
  const [dragging, setDragging] = useState(false)
  const latest = useRef(options)
  const pending = useRef(0)
  const count = useRef(0)
  const counter = useRef(0)
  const mounted = useRef(true)
  const kept = useRef<PictureItem[]>([])

  const known = new Set(local.map(item => item.file).filter((name): name is string => !!name))
  const server: PictureItem[] = stored.filter(name => !gone.includes(name) && !known.has(name)).map(name => ({ id: `stored:${name}`, url: '', file: name, path: pathOf?.(name), state: 'ready' }))
  const items = [...server, ...local]

  useEffect(() => { latest.current = options; count.current = items.length; kept.current = local })
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; kept.current.forEach(item => { if (item.url) URL.revokeObjectURL(item.url) }) }
  }, [])

  const patch = (id: string, change: Partial<PictureItem>) => setLocal(current => current.map(item => (item.id === id ? { ...item, ...change } : item)))

  const save = async (item: PictureItem) => {
    const { store } = latest.current
    if (!store || !item.prepared) return
    patch(item.id, { state: 'uploading', error: undefined })
    try {
      const file = await store(item.prepared)
      if (mounted.current) patch(item.id, { state: 'ready', file })
    } catch (failure) {
      if (mounted.current) patch(item.id, { state: 'failed', error: failure instanceof HubError ? failure.message : SAVE_FAILED })
    }
  }

  const add = async (files: File[]) => {
    const { locked, noun, max } = latest.current
    if (locked) { setNote(locked); return }
    const pictures = files.filter(isPicture)
    const said: string[] = []
    if (pictures.length < files.length) said.push('Only pictures can be attached.')
    const room = max - count.current - pending.current
    if (pictures.length > room) said.push(`${noun} takes at most ${max} pictures.`)
    const take = pictures.slice(0, Math.max(0, room))
    pending.current += take.length
    setNote(said.join(' ') || null)
    if (!take.length) return
    setPreparing(n => n + take.length)
    for (const file of take) {
      try {
        const made = await prepareImage(file)
        if (!mounted.current) { URL.revokeObjectURL(made.url); pending.current -= 1; continue }
        counter.current += 1
        const item: PictureItem = { id: `local:${counter.current}`, url: made.url, prepared: made, state: latest.current.store ? 'uploading' : 'ready' }
        count.current += 1
        setLocal(current => [...current, item])
        void save(item)
      } catch (failure) {
        if (mounted.current) setNote(failure instanceof Error ? failure.message : CANNOT_OPEN)
      }
      pending.current -= 1
      if (mounted.current) setPreparing(n => n - 1)
    }
  }

  const remove = (item: PictureItem) => {
    if (item.url) URL.revokeObjectURL(item.url)
    count.current -= 1
    setNote(null)
    if (item.file) {
      const file = item.file
      setGone(current => [...current, file])
      const { discard } = latest.current
      if (discard) void discard(file).catch(failure => { if (mounted.current) setNote(failure instanceof Error ? failure.message : 'That picture was not removed.') })
    }
    setLocal(current => current.filter(other => other.id !== item.id))
  }

  const dropProps = {
    onDragEnter: (event: DragEvent) => { if (hasFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true) } },
    onDragOver: (event: DragEvent) => { if (hasFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true) } },
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event.dataTransfer)) return
      event.preventDefault()
      setDragging(false)
      void add(Array.from(event.dataTransfer.files))
    },
  }

  return {
    items, add, remove, retry: (item: PictureItem) => void save(item), note, setNote, preparing, dragging, dropProps,
    uploading: items.some(item => item.state === 'uploading'),
    failed: items.some(item => item.state === 'failed'),
    /** Nothing is being prepared or saved, and nothing failed: safe to send. */
    ready: preparing === 0 && items.every(item => item.state === 'ready'),
    /** The names of the pictures the server holds for these items, in tray order. */
    files: () => items.filter(item => item.state === 'ready' && item.file).map(item => item.file as string),
    /** Pictures made here that are not saved on the server (Chat). */
    local: (): Prepared[] => local.filter(item => item.state === 'ready' && item.prepared).map(item => item.prepared as Prepared),
    /** Empties the tray. With `keepUrls` the object URLs stay alive (a sent bubble still shows them). */
    clear: (keepUrls = false) => {
      if (!keepUrls) local.forEach(item => { if (item.url) URL.revokeObjectURL(item.url) })
      count.current = server.length
      setLocal([])
      setNote(null)
    },
    /** Puts pictures back in the tray (a send that failed). */
    restore: (pictures: Prepared[]) => {
      const back = pictures.map<PictureItem>(prepared => { counter.current += 1; return { id: `local:${counter.current}`, url: prepared.url, prepared, state: 'ready' } })
      count.current = back.length
      setLocal(back)
    },
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      const files = pictureFiles(event.clipboardData)
      if (!files.length) return
      if (!event.clipboardData.getData('text/plain')) event.preventDefault()
      void add(files)
    },
  }
}

export type Pictures = ReturnType<typeof usePictures>
