/** Shared bunnyUFO mark for the Workspace. */
export default function BrandLogo({ size = 64 }: { size?: number; animated?: boolean }) {
  return <img className="brand-logo" src="/assets/bunnyufo-logo.svg" width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: 'block', flexShrink: 0, objectFit: 'contain' }} />
}
