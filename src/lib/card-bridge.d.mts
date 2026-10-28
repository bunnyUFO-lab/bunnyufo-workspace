export const BRIDGE_TYPE: 'buw:bridge'
export const BRIDGE_OPS: string[]
export interface BridgeCard { workspace: string; id: string }
export type BridgeReply = { type: 'buw:bridge'; v: 1; id: string } & (
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: string; current?: unknown })
export function isBridgeRequest(data: unknown): boolean
export function createBridgeHandler(options: {
  card: BridgeCard
  enabled: boolean | (() => boolean)
  call: (path: string, body?: unknown) => Promise<unknown>
  now?: () => number
}): { handle: (data: unknown) => Promise<BridgeReply | null> }
export function attachCardBridge(
  frame: { contentWindow: Window | null },
  card: BridgeCard,
  options: { origin: string; enabled: boolean | (() => boolean); call: (path: string, body?: unknown) => Promise<unknown>; win?: Window; now?: () => number },
): () => void
