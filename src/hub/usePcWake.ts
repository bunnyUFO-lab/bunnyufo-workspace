import { useEffect, useState } from 'react'
import { HUB_WROTE, hubGet } from '../lib/hub'
import type { PcWake } from '../lib/hubPc'

/** What the server says about waking the PC, kept fresh with the Hub's own refresh event. Null until it answers. */
export function usePcWake(enabled = true): PcWake | null {
  const [wake, setWake] = useState<PcWake | null>(null)
  useEffect(() => {
    if (!enabled) return undefined
    const controller = new AbortController()
    const load = () => { hubGet<{ wake?: PcWake }>('/pc', controller.signal).then(answer => setWake(answer.wake ?? null), () => { /* no wake line */ }) }
    load()
    window.addEventListener(HUB_WROTE, load)
    const timer = window.setInterval(load, 30000)
    return () => { controller.abort(); window.removeEventListener(HUB_WROTE, load); window.clearInterval(timer) }
  }, [enabled])
  return wake
}
