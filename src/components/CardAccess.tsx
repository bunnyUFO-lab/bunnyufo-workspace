import { Copy } from './SkillPacks'
import { host } from '../lib/host'

/**
 * How an agent away from the home PC reaches the cards: through the card API (site/card-api),
 * with the owner's passphrase. Nothing here can set it up — a page cannot write to a terminal or
 * an agent's environment, and it does not know the passphrase — so it hands over the one command
 * and the values to paste.
 */
export const cardApiHost = (apiBase: string) => new URL(apiBase).host

/**
 * Fetches the client to ~/.buw/cards.mjs and runs its `login`, which asks for the passphrase.
 * One line that bash, zsh and PowerShell all pass to Node unchanged: no `$`, no backtick, no `!`
 * (bash history) and no double quote inside.
 */
export const setupCommand = (apiBase: string) => 'node -e "'
  + "const p=require('path'),fs=require('fs'),f=p.join(require('os').homedir(),'.buw','cards.mjs');"
  + `fetch('${apiBase.replace(/\/+$/, '')}/cards.mjs').then(r=>r.ok?r.text():Promise.reject(Error('HTTP '+r.status)))`
  + ".then(t=>{fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,t);console.log('Saved '+f);"
  + "require('child_process').spawnSync(process.execPath,[f,'login'],{stdio:'inherit'})})"
  + '"'

export default function CardAccess() {
  const apiBase = host.cardApi
  if (!apiBase) {
    return (
      <div className="card-access">
        <h2>Workspace API setup</h2>
        <p>No card API is set. Add <code>"cardApi": "https://…"</code> to <code>~/.buw/config.json</code> and reload.</p>
      </div>
    )
  }
  const apiHost = cardApiHost(apiBase)
  return (
    <div className="card-access">
      <h2>Workspace API setup</h2>
      <div className="site-skill">
        <strong>A terminal</strong>
        <small>
          Paste into any terminal with Node 22. It saves the client to <code>~/.buw/cards.mjs</code> and
          asks for the passphrase once. Agents there then run <code>node ~/.buw/cards.mjs get &lt;link&gt;</code>.
        </small>
        <div className="site-skill-row">
          <span />
          <Copy command={setupCommand(apiBase)} label="Copy setup command" />
        </div>
      </div>
      <div className="site-skill">
        <strong>Claude Code cloud</strong>
        <small>
          In the environment's settings: network access <em>Custom</em> with this website among the
          allowed domains, and the variable <code>BUW_CARDS_PASSWORD=</code> the passphrase. (Where
          offered, <em>Add secret</em> keeps it out of the session: type Bearer,
          header <code>Authorization</code>, prefix <code>Bearer</code>, for this website.)
        </small>
        <div className="site-skill-row">
          <code>{apiHost}</code>
          <Copy command={apiHost} label="Copy website" />
        </div>
      </div>
    </div>
  )
}
