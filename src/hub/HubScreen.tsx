import './hub.css'
import type { HubRoute } from '../lib/route'
import { host } from '../lib/host'
import Activity from './Activity'
import AskView from './AskView'
import Board from './Board'
import Md from './Md'
import Chat from './Chat'
import Inbox from './Inbox'
import Sketch from './Sketch'
import ProgressMap from './ProgressMap'
import Today from './Today'

/** The Hub: one entry for every screen, with the banner that says when this visitor can only read. */
export default function HubScreen({ route }: { route: HubRoute }) {
  return (
    <div className="hub" data-screen={route.screen}>
      {!host.write && (
        <div className="hub-banner" role="note">
          <Md text={`${host.reason ?? 'Read-only here.'} Answering Asks, Sketch and sending requests to agents need you to be signed in.`} />
        </div>
      )}
      {route.screen === 'today' && <Today />}
      {route.screen === 'inbox' && <Inbox filter={route.id} />}
      {route.screen === 'ask' && (route.id ? <AskView key={route.id} id={route.id} /> : <Inbox filter="asks" />)}
      {route.screen === 'board' && <Board project={route.id} />}
      {route.screen === 'activity' && <Activity filter={route.id} />}
      {route.screen === 'map' && <ProgressMap project={route.id} />}
      {route.screen === 'sketch' && <Sketch id={route.id} />}
      {route.screen === 'chat' && <Chat id={route.id} />}
    </div>
  )
}
