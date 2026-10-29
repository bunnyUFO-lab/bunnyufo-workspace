// Project defaults: display name, order on the Roadmap, Beads prefix, and where work runs by
// default. Kept in code, not in the bucket: routing reads it and no agent token may change it.
/** @typedef {'pc' | 'cloud' | 'at-pc'} RunsOn */
export const PROJECT_DEFAULTS = [
  { id: 'magic-loops', name: 'Magic Loops', order: 1, prefix: 'ml', runsOn: 'pc' },
  { id: 'sprite-studio', name: 'Sprite Studio', order: 2, prefix: 'ss', runsOn: 'pc' },
  { id: 'workspace-app', name: 'Workspace app', order: 3, prefix: 'ws', runsOn: 'cloud' },
  { id: 'bunnylink', name: 'Bunnylink', order: 4, prefix: 'bl', runsOn: 'at-pc' },
  { id: 'shadowdark', name: 'Discord bots', order: 5, prefix: 'sd', runsOn: 'cloud' },
];
export const defaultsOf = id => PROJECT_DEFAULTS.find(row => row.id === id) ?? null;
