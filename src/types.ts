export interface WorkspaceStep {
  name: string
  path: string
  /**
   * Omitted = HTML in an iframe, formatted Markdown, or an image preview,
   * selected by file extension. `compare3d` = a Compare3DManifest JSON and
   * the step renders the side-by-side 3D viewer instead.
   */
  viewer?: 'compare3d'
  /**
   * A live web app (http/https) shown full-size in the tab, such as a local
   * tool's UI. `path` is then its Markdown instructions page, shown on demand,
   * when the app does not answer, and on the docs site.
   */
  url?: string
}

export interface WorkspaceEntity {
  id: string
  title: string
  description: string
  /** Optional project emblem, relative to this entity's folder. */
  icon?: string
  type: 'standalone' | 'group'
  category: string
  /** Game project this card belongs to (the project hub's id); set by the gamedev-workspace skill. */
  project?: string
  /** On a project hub: the game repository's local path, used to link a repo to its hub. */
  repo?: string
  created: string
  /** Last day an agent touched this entity; dashboard sorts/archives by it. */
  updated?: string
  folder: string
  steps: WorkspaceStep[]
  /** Tab to open for a card link without an explicit step; otherwise use latest. */
  defaultStep?: number
  status: 'active' | 'done' | 'archived'
  pinned?: boolean
  /** Where this card sits in the pinned list, low first. Written by dragging a pin into place;
   *  a pin without one waits at the bottom, newest first, until it is dragged somewhere. */
  pinOrder?: number
  /** Free-text labels set from the app; kept in the shared state object, not in the card. */
  tags?: string[]
  /** An icon picked in the app (one emoji), kept with the tags; wins over `icon` and the category's. */
  emoji?: string
  /** Starter examples remain visible until explicitly archived. */
  sample?: boolean
  /** Tabs deleted from this card, newest last. The file stays in the folder; the "+" form can put one back. */
  removedTabs?: RemovedTab[]
}

/** A tab taken off a card: the step as it was, when, and where it sat. */
export interface RemovedTab extends WorkspaceStep {
  at: string
  index: number
  wasDefault?: boolean
}

/** A workspace.json `retired` record: a card moved to another workspace, or in this one's Trash. */
export type RetiredCard =
  | { kind: 'moved'; to: string; folder: string; at: string }
  | { kind: 'deleted'; at: string; entity: WorkspaceEntity }

export interface WorkspaceState {
  entities: WorkspaceEntity[]
  retired?: Record<string, RetiredCard>
}

/**
 * The workspace a card came from. Every registered workspace is on screen at once and the project
 * filter narrows it, so a card can no longer assume "the active workspace": where its files are
 * served from, where they live on disk and which repository holds them all travel with the card.
 */
export interface CardWorkspace {
  id: string
  name: string
  /** Base URL the card folders are served from, without a trailing slash. */
  base: string
  /** Absolute folder on this disk. Local app only; a published site has no paths to show. */
  root?: string
  repo?: string | null
  /** Where this workspace's folder sits inside `repo`: "sections/agent-plans", or absent at its
   * root. Several workspaces share one repository now, so a card's source link needs it. */
  repoPath?: string
  /** Ref the site was published from, when this workspace is a published site. */
  branch?: string
  /** Published address of this workspace, for the "open on the site" link. */
  site?: string | null
  /** Where it publishes: "s3://<bucket>/sections/<id>". Local app only. */
  bucket?: string | null
  /** The workspace agents, skills and new cards write to. Exactly one, and only in the local app. */
  active?: boolean
  /** The app's own starter examples: shown, never written to. Local app only. */
  builtin?: boolean
  /** Hidden or archived workspaces take no moved cards. */
  hidden?: boolean
  archived?: boolean
  /** Cards moved away or in the Trash, from this workspace's card list. */
  retired?: Record<string, RetiredCard>
}

/** A card with the workspace it belongs to. The app works in these, not in bare entities. */
export interface WorkspaceCard extends WorkspaceEntity {
  workspace: CardWorkspace
}

/* ─── 3D comparison steps ─────────────────────────────────────────────────
   A manifest lives inside the entity folder next to a models/ directory. Paths
   in `file` are relative to the manifest. Model binaries stay local (gitignored,
   they run to tens of MB) — the manifest and the card are what get versioned. */

export interface Compare3DModel {
  /** Path to the .glb, relative to the manifest file. */
  file: string
  /** Shown above the pane — the generator name and version. */
  label: string
  /** Logo shown next to the label, relative to the manifest file. */
  logo?: string
  /** Optional second line: version, settings, generation time. */
  note?: string
  /** Optional colour for the pane label. */
  accent?: string
  /** Extra yaw in degrees, for exports that come out facing the wrong way. */
  rotationY?: number
  /**
   * Cover name shown instead of `label` while Redact is on. For models under
   * embargo: the card is filmed with the alias up, and the toggle reveals the
   * real name for the user's own use.
   */
  alias?: string
}

export interface Compare3DTest {
  id: string
  name: string
  /** `lowpoly` opens on the wireframe and hides texture-channel modes. */
  kind: 'lowpoly' | 'highpoly'
  /** Overrides the per-kind default opening mode. */
  defaultMode?: 'wire' | 'quads' | 'solid' | 'normals' | 'pbr' | 'albedo' | 'normalMap' | 'rough' | 'metal'
  note?: string
  /**
   * The reference image every model in this test was generated from, relative
   * to the manifest. Rendered as a thumbnail in the bar and full size on click
   * — without it there is no way to judge a result against its input.
   */
  input?: string
  models: Compare3DModel[]
}

export interface Compare3DManifest {
  title?: string
  tests: Compare3DTest[]
}
