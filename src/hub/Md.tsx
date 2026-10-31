import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copyText } from './copyText'

type CopyState = 'idle' | 'copied' | 'oneLine' | 'manual'

/**
 * A fenced code block with a Copy button. A plain multi-line PowerShell block is copied as one line (see copyText), and the
 * button says so. If the clipboard says no, the text is selected and the button says to press and hold.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null)
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  async function copy() {
    const lang = /language-(\S+)/.exec(block.current?.querySelector('code')?.className ?? '')?.[1]
    const { text, oneLine } = copyText((block.current?.textContent ?? '').replace(/\n$/, ''), lang)
    let next: CopyState = oneLine ? 'oneLine' : 'copied'
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
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
    timer.current = window.setTimeout(() => setState('idle'), next === 'copied' ? 2000 : next === 'oneLine' ? 4000 : 6000)
  }
  return (
    <div className="hub-code">
      <pre ref={block}>{children}</pre>
      <button type="button" className="hub-btn hub-copy" data-copy onClick={() => void copy()} aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'oneLine' ? 'Copied as one line' : state === 'manual' ? 'Press and hold to copy' : 'Copy'}
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
      <SameOrigin.Provider value={onSameOrigin}>
        <Markdown remarkPlugins={[remarkGfm]} components={copy ? WITH_COPY : PLAIN}>{text}</Markdown>
      </SameOrigin.Provider>
    </div>
  )
}

const SameOrigin = createContext<((url: URL) => void) | undefined>(undefined)

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const onSameOrigin = useContext(SameOrigin)
  let url: URL | null = null
  try { url = href ? new URL(href, window.location.href) : null } catch { url = null }
  const same = !!url && url.origin === window.location.origin
  return (
    <a
      href={href}
      {...(same ? { onClick: (event: React.MouseEvent) => { if (onSameOrigin && url) { event.preventDefault(); onSameOrigin(url) } } } : { target: '_blank', rel: 'noopener noreferrer' })}
    >{children}</a>
  )
}

// Built once: a component made inline in render is a new type each time, so every re-render would swap the code block
// and its button for new ones. A checklist step re-renders on pointerdown (it becomes the target), and the click that
// followed was lost: the button under the mouse was gone by mouseup.
const PLAIN: Components = { a: Link }
const WITH_COPY: Components = { pre: CodeBlock, a: Link }
