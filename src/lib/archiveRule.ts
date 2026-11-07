// The archive rule lives in site/api/card-liveness.mjs, which the services share; the app reads it from there too.
export { ARCHIVE_DAYS, archiveCutoff, applyCardState, isArchivedCard, PURPOSES } from '../../site/api/card-liveness.mjs'
