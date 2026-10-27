import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Text that came from an agent or from Hermes. Markdown with GFM, no raw HTML (no rehype-raw), and
 * react-markdown's default URL transform, which drops javascript: links. Links open in a new tab
 * unless they point at this site, which `onSameOrigin` may handle in-app.
 */
export default function Md({ text, onSameOrigin }: { text: string; onSameOrigin?: (url: URL) => void }) {
  return (
    <div className="hub-md">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
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
