import './hub.css'
import type { HubRoute } from '../lib/route'
import { host } from '../lib/host'
import Activity from './Activity'
import AskView from './AskView'
import Board from './Board'
import ChecklistView from './ChecklistView'
import Md from './Md'
import ReviewView from './ReviewView'
import Chat from './Chat'
import Needs from './Needs'
import Sketch from './Sketch'
import SpawnHost from './Spawn'
import ProgressMap from './ProgressMap'
import Team from './Team'
import Today from './Today'
import WorkTabs from './WorkTabs'

/** The Hub: one entry for every screen, with the banner that says when this visitor can only read. */
export default function HubScreen({ route }: { route: HubRoute }) {
  return (
    <div className="hub" data-screen={route.screen}>
      {!host.write && (
        <div className="hub-banner" role="note">
          <Md text={`${host.reason ?? 'Read-only here.'} Answering Asks, ticking checklists, marking reviews done, Sketch and sending requests to agents need you to be signed in.`} />
        </div>
      )}
      {route.screen === 'today' && <Today />}
      {route.screen === 'needs' && <Needs filter={route.id} />}
      {route.screen === 'ask' && (route.id ? <AskView key={route.id} id={route.id} /> : <Needs filter="question" />)}
      {route.screen === 'checklist' && (route.id ? <ChecklistView key={route.id} id={route.id} /> : <Needs filter="steps" />)}
      {route.screen === 'review' && (route.id ? <ReviewView key={route.id.split('/')[0]} route={route.id} /> : <Needs filter="pr" />)}
      {route.screen === 'work' && <WorkTabs tab="lanes"><Board project={route.id} /></WorkTabs>}
      {route.screen === 'team' && <Team />}
      {route.screen === 'activity' && <WorkTabs tab="activity"><Activity filter={route.id} /></WorkTabs>}
      {route.screen === 'map' && <ProgressMap project={route.id} />}
      {route.screen === 'sketch' && <Sketch id={route.id} />}
      {route.screen === 'chat' && <Chat id={route.id} />}
      {host.write && <SpawnHost />}
    </div>
  )
}
