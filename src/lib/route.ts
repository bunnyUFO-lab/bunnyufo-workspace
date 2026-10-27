// Hash routing: #/<entityId>/<stepIndex>. Step -1 uses the card's default.
// Plain <a href> hash links do the navigation; App listens to hashchange.

export const HUB_SCREENS = ['today', 'inbox', 'ask', 'map', 'board', 'activity', 'sketch', 'chat'] as const
export type HubScreen = (typeof HUB_SCREENS)[number]

/** `#/~hub/<screen>[/<rest>]`. Card ids cannot contain `~`, so this never collides with a card. */
export interface HubRoute {
  screen: HubScreen
  id?: string
}

export interface Route {
  id: string | null
  step: number
  hub?: HubRoute
}

const safeDecode = (value: string) => { try { return decodeURIComponent(value) } catch { return value } }

export function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '')
  if (!raw) return { id: null, step: -1 }
  if (raw === '~hub' || raw.startsWith('~hub/')) {
    const [, screen, ...rest] = raw.split('/')
    const known = (HUB_SCREENS as readonly string[]).includes(screen) ? screen as HubScreen : 'today'
    const id = known === screen ? safeDecode(rest.join('/')) : ''
    return { id: null, step: -1, hub: { screen: known, ...(id ? { id } : {}) } }
  }
  const [id, stepRaw] = raw.split('/')
  const step = Number(stepRaw)
  return {
    id: decodeURIComponent(id),
    step: Number.isInteger(step) && step >= 0 ? step : -1,
  }
}

export function entityHash(id: string, step = -1): string {
  const base = `#/${encodeURIComponent(id)}`
  return step >= 0 ? `${base}/${step}` : base
}

export function hubHash(screen: HubScreen, id?: string): string {
  return id ? `#/~hub/${screen}/${encodeURIComponent(id)}` : `#/~hub/${screen}`
}

export function resolveStep(count: number, requested: number, preferred?: number): number {
  const valid = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < count
  return valid(requested) ? requested : valid(preferred) ? preferred : count - 1
}
