import { useEffect, useState } from 'react'
import type { SyntheticEvent } from 'react'
import { authHeaders } from '../local/client'
import { fileUrl } from '../lib/hub'

/**
 * A picture from the inbox, by `path` (a file the Hub serves) or by a full `url` (a chat picture, or
 * a local object URL). An <img> cannot carry the local service's bearer token, so the file is fetched
 * with it and shown from an object URL, which is revoked when the picture goes away. With `open`, the
 * picture links to itself full size in a new tab.
 */
export default function HubImage({ path, url, alt, className, onLoad, open }: { path?: string; url?: string; alt: string; className?: string; onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void; open?: boolean }) {
  const target = url ?? (path ? fileUrl(path) : '')
  const [loaded, setLoaded] = useState<{ target: string; src: string | null }>({ target: '', src: null })
  useEffect(() => {
    let made: string | null = null
    let stopped = false
    fetch(target, { headers: authHeaders() })
      .then(response => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then(blob => { if (stopped) return; made = URL.createObjectURL(blob); setLoaded({ target, src: made }) })
      .catch(() => { if (!stopped) setLoaded({ target, src: null }) })
    return () => { stopped = true; if (made) URL.revokeObjectURL(made) }
  }, [target])
  const src = loaded.target === target ? loaded.src : null
  const failed = loaded.target === target && !loaded.src
  if (failed) return <span className="hub-image-missing" role="img" aria-label={alt}>No picture</span>
  if (!src) return <span className="hub-image-loading" aria-hidden="true" />
  const image = <img className={className} src={src} alt={alt} onLoad={onLoad} />
  return open ? <a className="hub-image-open" href={src} target="_blank" rel="noopener" aria-label={`${alt}, full size`}>{image}</a> : image
}
