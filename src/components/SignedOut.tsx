import { BrandMark } from '../local/Icons'
import '../local/local.css'

/** The host is here and refused us: say so, instead of showing an empty board. */
export default function SignedOut({ message }: { message: string }) {
  return <div className="app-boot">
    <BrandMark size={70} />
    <h1>bunnyUFO Workspace</h1>
    <p>{message}</p>
    <button className="desk-secondary" onClick={() => window.location.reload()}>Reload</button>
  </div>
}
