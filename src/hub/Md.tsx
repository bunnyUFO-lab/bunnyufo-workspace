import { useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type CopyState = 'idle' | 'copied' | 'manual'

/** A fenced code block with a Copy button. If the clipboard says no, the text is selected and the button says to press and hold. */
function CodeBlock({ children }: { children: ReactNode }) {
  const block = useRef<HTMLPreElement>(null)
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  async function copy() {
    const code = (block.current?.textContent ?? '').replace(/\n$/, '')
    let next: CopyState = 'copied'
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(code)
    } catch {
      next = 'manual'
      const selection = window.getSelection()
      if (block.current && selection) {
        const range = document.createRange()
        range.selectNodeContents(block.current)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
    setState(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), next === 'copied' ? 2000 : 6000)
  }
  return (
    <div className="hub-code">
      <pre ref={block}>{children}</pre>
      <button type="button" className="hub-btn hub-copy" data-copy onClick={() => void copy()} aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'manual' ? 'Press and hold to copy' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * Text that came from an agent or from Hermes. Markdown with GFM, no raw HTML (no rehype-raw), and
 * react-markdown's default URL transform, which drops javascript: links. Links open in a new tab
 * unless they point at this site, which `onSameOrigin` may handle in-app. With `copy`, each fenced code block
 * (not inline code) gets a Copy button; other screens leave it off.
 */
export default function Md({ text, onSameOrigin, copy = false }: { text: string; onSameOrigin?: (url: URL) => void; copy?: boolean }) {
  return (
    <div className="hub-md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          ...(copy ? { pre: ({ children }: { children?: ReactNode }) => <CodeBlock>{children}</CodeBlock> } : {}),
          a: ({ href, children }) => {
            let url: URL | null = null
            try { url = href ? new URL(href, window.location.href) : null } catch { url = null }
            const same = !!url && url.origin === window.location.origin
            return (
              <a
                href={href}
                {...(same ? { onClick: (event: React.MouseEvent) => { if (onSameOrigin && url) { event.preventDefault(); onSameOrigin(url) } } } : { target: '_blank', rel: 'noopener noreferrer' })}
              >{children}</a>
            )
          },
        }}
      >{text}</Markdown>
    </div>
  )
}
