/** Agent CLIs whose MCP configuration the inspector reads, shown with their logos. */
export type AgentId = 'codex' | 'claude' | 'opencode' | 'kimi' | 'shell'
export interface Settings { workspaceTheme?: 'dark' | 'light' | 'system'; workspaceRoute?: string | null }
export interface FileEntry { name: string; path: string; directory: boolean; size: number; modifiedAt: string | null }
export interface Folder { path: string; parent: string; entries: FileEntry[]; truncated: boolean; mode: string }
export interface Preview { path: string; name: string; size: number; kind: 'document' | 'image' | 'video' | 'audio' | 'text' | 'unsupported'; url?: string; text?: string; revision?: string; reason?: string }
/** The folder of cards the app shows: the app's starter examples or a registered workspace repo. */
export interface ActiveWorkspace { id: string; name: string; root: string; builtin: boolean; pinned: boolean; repo: string | null; site: string | null; contentBase: string }
export interface WorkspaceEntry { id: string; name: string; root: string; builtin: boolean; repo: string | null; site: string | null; exists: boolean }
export interface ServiceState {
  ready: boolean; connected: boolean; error: string | null; repo: string; contentBase: string
  workspace: ActiveWorkspace | null; settings: Settings; preview: Preview | null
}
export interface ServiceEvent {
  type: string; error?: string; settings?: Settings; window?: string; route?: string; preview?: Preview; workspace?: ActiveWorkspace
}
