import { setPreview } from './client'
import type { Preview } from './types'
import { Icon } from './Icons'
import MarkdownDocument, { MarkdownView } from '../components/MarkdownDocument'
import { ZoomImage } from '../components/ImagePreview'
import ReportFrame from '../components/ReportFrame'
import { host } from '../lib/host'

export default function FilePreview({ file }: { file: Preview }) {
  return <div className="file-preview"><header><span><Icon name="files" size={16} /><strong title={file.name}>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB</small></span><div><button className="desk-icon" onClick={() => setPreview(null)} title="Back to Workspace" aria-label="Close file preview"><Icon name="close" size={18} /></button></div></header><div className={`file-preview-body ${file.kind}`}>
    {file.kind === 'text' && (/\.md$/i.test(file.name) ? host.saves ? <MarkdownDocument key={`${file.path}:${file.revision}`} file={file} /> : <div className="markdown-reader"><MarkdownView text={file.text || ''} baseUrl={file.url} /></div> : <pre>{file.text}</pre>)}
    {file.kind === 'document' && file.url && <ReportFrame url={file.url} title={file.name} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" />}
    {file.kind === 'image' && <ZoomImage src={file.url} alt={file.name} />}
    {file.kind === 'video' && <video src={file.url} controls />}
    {file.kind === 'audio' && <audio src={file.url} controls />}
    {file.kind === 'unsupported' && <div className="file-unsupported"><Icon name="files" size={38} /><h2>{file.name}</h2><p>{file.reason}</p><small title={file.path}>{file.path}</small></div>}
  </div></div>
}
