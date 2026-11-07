export const IMAGE_TYPE: 'buw:image'
export function isImageRequest(data: unknown): boolean
export function resolveFrameImage(src: string, frameFolder: string, appFolder: string): string | null
export function attachImageOpen(
  frame: { contentWindow: Window | null },
  options: {
    origin: string
    resolve: (src: string) => string | null
    open: (picture: { url: string; urls: string[] }) => void
    isOpen: () => boolean
    closedAt?: () => number
    activated?: () => boolean
    win?: Window
    now?: () => number
  },
): () => void
