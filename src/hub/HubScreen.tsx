import { useEffect, useState } from 'react'
import './hub.css'
import { parseWorkId, type HubRoute } from '../lib/route'
import { host } from '../lib/host'
import { chatNote } from '../lib/hubNav'
import Activity from './Activity'
import AgentEdit from './AgentEdit'
import ApprovalView from './ApprovalView'
import AskView from './AskView'
import Board from './Board'
import ChecklistView from './ChecklistView'
import Md from './Md'
import ReviewView from './ReviewView'
import Chat from './Chat'
import Jobs from './Jobs'
import Needs from './Needs'
import Sketch from './Sketch'
import SpawnHost from './Spawn'
import ProjectsScreen from './ProjectsList'
import Team from './Team'
import Today from './Today'
import WorkTabs from './WorkTabs'

/** The Hub: one entry for every screen, with the banner that says when this visitor can only read. */
export default function HubScreen({ route }: { route: HubRoute }) {
  // A card link of the site (`/<section>#/<card>`) means nothing to the local copy of the app, which has no page at that path: it would show the
  // service's raw error. There the click says so inside the app instead.
  const [noSite, setNoSite] = useState('')
  useEffect(() => {
    if (host.routes !== 'hash') return undefined
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a[href]')
      const href = link?.getAttribute('href') ?? ''
      if (!/^\/[\w%-]+#\/[\w%.~-]+$/.test(href) || event.defaultPrevented) return
      event.preventDefault()
      setNoSite(`This card is in the section "${decodeURIComponent(href.slice(1, href.indexOf('#')))}", which this copy of the app cannot open. Open it on the site.`)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
  return (
    <div className="hub" data-screen={route.screen === 'map' ? 'project' : route.screen}>
      {noSite && <div className="hub-banner" role="alert" data-hub-no-site>{noSite} <button type="button" className="hub-btn" onClick={() => setNoSite('')}>Close</button></div>}
      {!host.write && (
        <div className="hub-banner" role="note">
          <Md text={host.reason ?? 'Read-only here. Sign in to change anything.'} />
        </div>
      )}
      {route.screen === 'today' && <Today />}
      {route.screen === 'needs' && <Needs filter={route.id} />}
      {route.screen === 'ask' && (route.id ? <AskView key={route.id} id={route.id} /> : <Needs filter="question" />)}
      {route.screen === 'checklist' && (route.id ? <ChecklistView key={route.id} id={route.id} /> : <Needs filter="steps" />)}
      {route.screen === 'review' && (route.id ? <ReviewView key={route.id.split('/')[0]} route={route.id} /> : <Needs filter="pr" />)}
      {route.screen === 'request' && (route.id ? <ApprovalView key={route.id} id={route.id} /> : <Needs filter="approvals" />)}
      {route.screen === 'work' && <WorkTabs tab="board"><Board project={parseWorkId(route.id).project} focus={parseWorkId(route.id).bead} at={parseWorkId(route.id).at} sprint={route.sprint} /></WorkTabs>}
      {(route.screen === 'team' || route.screen === 'agent') && <Team routeId={route.screen === 'team' ? route.id : undefined} agentId={route.screen === 'agent' ? route.id : undefined} />}
      {route.screen === 'agent-edit' && (route.id ? <AgentEdit key={route.id} id={route.id} /> : <Team />)}
      {route.screen === 'activity' && <WorkTabs tab="activity"><Activity filter={route.id} /></WorkTabs>}
      {route.screen === 'jobs' && <Jobs tab={route.id} />}
      {(route.screen === 'project' || route.screen === 'map') && <ProjectsScreen route={route} />}
      {route.screen === 'sketch' && <Sketch id={route.id} />}
      {route.screen === 'chat' && (chatNote(host) ? <p className="hub-empty" data-hub-chat-note>{chatNote(host)}</p> : <Chat id={route.id} />)}
      {host.write && <SpawnHost />}
    </div>
  )
}
