import { useEffect, useState } from 'react'
import type { SyntheticEvent } from 'react'
import { authHeaders } from '../local/client'
import { fileUrl } from '../lib/hub'

/**
 * A picture from the inbox. An <img> cannot carry the local service's bearer token, so the file is
 * fetched with it and shown from an object URL, which is revoked when the picture goes away.
 */
export default function HubImage({ path, alt, className, onLoad }: { path: string; alt: string; className?: string; onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void }) {
  const [loaded, setLoaded] = useState<{ path: string; src: string | null }>({ path: '', src: null })
  useEffect(() => {
    let url: string | null = null
    let stopped = false
    fetch(fileUrl(path), { headers: authHeaders() })
      .then(response => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then(blob => { if (stopped) return; url = URL.createObjectURL(blob); setLoaded({ path, src: url }) })
      .catch(() => { if (!stopped) setLoaded({ path, src: null }) })
    return () => { stopped = true; if (url) URL.revokeObjectURL(url) }
  }, [path])
  const src = loaded.path === path ? loaded.src : null
  const failed = loaded.path === path && !loaded.src
  if (failed) return <span className="hub-image-missing" role="img" aria-label={alt}>No picture</span>
  if (!src) return <span className="hub-image-loading" aria-hidden="true" />
  return <img className={className} src={src} alt={alt} onLoad={onLoad} />
}
