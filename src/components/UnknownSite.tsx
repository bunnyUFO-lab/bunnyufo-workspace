import { allSites, siteHref, unknownSiteId } from '../lib/sites'

/**
 * The address names a workspace this site does not serve. Published sites used to fall back to the
 * first workspace in the list, which looked like success while showing someone else's cards.
 */
export default function UnknownSite() {
  return <div className="site-missing">
    <div className="site-missing-box">
      <h1>No workspace "{unknownSiteId}" here</h1>
      <p>This site does not serve that workspace. It may not have published yet: a workspace joins the
        list the first time its "Publish site" workflow runs.</p>
      {allSites.length > 0 && <>
        <p>Workspaces on this site:</p>
        <nav className="site-missing-list">
          {allSites.map(site => <a key={site.id} href={siteHref(site)}>{site.name}</a>)}
        </nav>
      </>}
    </div>
  </div>
}
