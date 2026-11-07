import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkBreaks } from './chatText'
import { copyText } from './copyText'
import { cardLinkOf } from './cardLink'

type CopyState = 'idle' | 'copied' | 'oneLine' | 'manual'

/**
 * A fenced code block with a Copy button. A plain multi-line PowerShell block is copied as one line (see copyText), and the
 * button says so. If the clipboard says no, the text is selected and the button says to press and hold. The block scrolls
 * sideways instead of wrapping, and the button sits at its top right, beside the text. With `exact`, the text is copied
 * as it is (a checklist item's command), not minus Markdown's last newline.
 */
export function CodeBlock({ children, exact = false }: { children?: ReactNode; exact?: boolean }) {
  const block = useRef<HTMLPreElement>(null)
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  async function copy() {
    const lang = /language-(\S+)/.exec(block.current?.querySelector('code')?.className ?? '')?.[1]
    // A fenced block ends in the newline Markdown adds; a command is copied exactly as written.
    const shown = block.current?.textContent ?? ''
    const { text, oneLine } = copyText(exact ? shown : shown.replace(/\n$/, ''), lang)
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
 * (not inline code) gets a Copy button; other screens leave it off. With `breaks`, a newline inside a paragraph is a
 * line break, as chat apps show replies. With `cardButtons`, a link to a card on this site becomes an "Open card" button
 * that opens the card in a new tab.
 */
export default function Md({ text, onSameOrigin, copy = false, breaks = false, cardButtons = false }: { text: string; onSameOrigin?: (url: URL) => void; copy?: boolean; breaks?: boolean; cardButtons?: boolean }) {
  return (
    <div className="hub-md">
      <SameOrigin.Provider value={onSameOrigin}>
        <CardButtons.Provider value={cardButtons}>
          <Markdown remarkPlugins={breaks ? GFM_BREAKS : GFM} components={copy ? WITH_COPY : PLAIN}>{text}</Markdown>
        </CardButtons.Provider>
      </SameOrigin.Provider>
    </div>
  )
}

const SameOrigin = createContext<((url: URL) => void) | undefined>(undefined)
const CardButtons = createContext(false)

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const onSameOrigin = useContext(SameOrigin)
  const cardButtons = useContext(CardButtons)
  const card = cardButtons ? cardLinkOf(href, window.location.href) : null
  if (card && href) {
    // The label always starts "Open card:", so link text from a model cannot paint a button that says something else.
    const own = typeof children === 'string' ? children.trim() : Array.isArray(children) && children.every(child => typeof child === 'string') ? children.join('').trim() : ''
    const label = own && own !== href && own !== card.href ? own : card.card
    return <a className="hub-btn hub-card-open" href={card.href} target="_blank" rel="noopener noreferrer" data-card-link>Open card: {label}</a>
  }
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
const GFM = [remarkGfm]
const GFM_BREAKS = [remarkGfm, remarkBreaks]
