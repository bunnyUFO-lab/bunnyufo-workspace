import { host, type HostCapabilities } from './host'

/**
 * What this host can do, read once before mount (lib/host). Kept as hooks so callers read
 * like React and a later live probe would not change them.
 */
export const useCapabilities = (): HostCapabilities => host

/** Can this page change a card — pin, reorder, archive? A site without a write API stays read-only. */
export const useCanWrite = (): boolean => host.write
