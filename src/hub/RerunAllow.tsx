import type { Ask } from '../lib/hub'
import { text } from './askAnswer'

/** The rules an "allow" answer adds to the project's PC allow list, in full (the Ask is an agent's file: the owner reads what is signed). */
function allowRules(ask: Ask): string[] {
  const rules = ask.rerun?.allow
  return Array.isArray(rules) ? rules.filter((rule): rule is string => typeof rule === 'string' && rule !== '') : []
}

export default function RerunAllow({ ask }: { ask: Ask }) {
  const rules = allowRules(ask)
  if (rules.length === 0 || ask.rerunBlocked) return null
  return (
    <section className="rerun-allow" data-rerun-allow aria-label="The rules the Allow option adds">
      <p><strong>Allow</strong> adds to {text(ask.project)}&apos;s PC allow list, for every later run:</p>
      <pre className="rerun-allow-rules"><code>{rules.join('\n')}</code></pre>
    </section>
  )
}
