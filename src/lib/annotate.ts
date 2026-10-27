import { createContext } from 'react'

/**
 * What lets a picture on a card page be annotated: set by the viewer of a card that can be written
 * to (ReportViewer), read by every image shown inside it. Without a provider (help pages, anywhere
 * outside a card) it is null and no picture offers ✎ Annotate.
 */
export interface Annotate {
  /** Address of the card's folder, absolute and with a trailing slash. */
  folderUrl: string
  /** Start a drawing over a picture (its path inside the card folder) and open it. */
  annotate: (path: string, width: number, height: number) => Promise<void>
}

export const AnnotateContext = createContext<Annotate | null>(null)

const PICTURE = /\.(png|jpe?g|webp|gif|svg)$/i

/** The picture's path inside the card folder when it is one of this card's own files, otherwise null. */
export function annotatable(context: Annotate | null, src: string | undefined): string | null {
  if (!context || !src) return null
  let absolute: URL
  try { absolute = new URL(src, window.location.href) } catch { return null }
  const bare = `${absolute.origin}${absolute.pathname}`
  if (!bare.startsWith(context.folderUrl) || !PICTURE.test(absolute.pathname)) return null
  try { return decodeURIComponent(bare.slice(context.folderUrl.length)) } catch { return null }
}

/** Where a drawing's background picture is: a file beside the scene, named in it, so # ? and % in the name are escaped. */
export const backgroundUrl = (name: string, sceneUrl: URL): URL =>
  new URL(name.split('/').map(encodeURIComponent).join('/'), sceneUrl)
