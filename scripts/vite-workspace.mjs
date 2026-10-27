// Vite plugin for the browser preview (npm run dev): serves the active workspace's files at
// /workspace/*, resolved on every request so switching workspaces needs no restart.
// Replaces the old public/workspace junction, which pointed only at <repo>/workspace.
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultRegistryFile, resolveWorkspace } from '../server/workspaces.mjs';

const types = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
};

export default function workspaceFiles({ appRepo }) {
  return {
    name: 'buw-workspace-files',
    configureServer(server) {
      server.middlewares.use('/workspace', async (request, response, next) => {
        try {
          const workspace = await resolveWorkspace({ appRepo, registryFile: defaultRegistryFile() });
          const root = await realpath(workspace.root);
          const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\/+/, '');
          const file = path.resolve(root, relative);
          const rel = path.relative(root, file);
          if (rel.startsWith('..') || path.isAbsolute(rel) || rel.split(/[\\/]/).some(part => part.startsWith('.'))) { response.statusCode = 403; response.end('Forbidden'); return; }
          const actual = await realpath(file);
          if (path.relative(root, actual).startsWith('..')) { response.statusCode = 403; response.end('Forbidden'); return; }
          const info = await stat(actual);
          if (!info.isFile()) return next();
          response.setHeader('Content-Type', types[path.extname(actual).toLowerCase()] || 'application/octet-stream');
          response.setHeader('Cache-Control', 'no-cache');
          response.setHeader('X-Buw-Workspace', workspace.id);
          createReadStream(actual).pipe(response);
        } catch (error) {
          if (error.code === 'ENOENT') { response.statusCode = 404; response.end('Not found'); return; }
          next(error);
        }
      });
    },
  };
}
