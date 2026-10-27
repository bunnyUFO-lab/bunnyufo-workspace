// Minimal MCP server (stdio, newline-delimited JSON-RPC 2.0) with the workspace's GPU tools.
// Sprite Studio's own MCP server does the art; this one only reports and hands over the shared GPU.
// Run: node tools/gpu/mcp.mjs
import { createInterface } from 'node:readline'
import { freeComfy, gpuStatus, unloadOllama } from './guard.mjs'

const TOOLS = [
  {
    name: 'gpu_status',
    description: 'Who holds the shared GPU: ComfyUI free VRAM and queue, Ollama models loaded (with VRAM), and settings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'free_gpu',
    description: 'Hand the shared GPU to one side. for="art" unloads every local Ollama model (ComfyUI gets the GPU); '
      + 'for="llm" unloads ComfyUI\'s models and caches so a big local model fits (fails while ComfyUI is busy).',
    inputSchema: { type: 'object', properties: { for: { type: 'string', enum: ['art', 'llm'] } }, required: ['for'] },
  },
]

const INSTRUCTIONS = 'GPU coordination for the local Sprite Studio / ComfyUI and Ollama stack. Use Sprite Studio\'s own MCP '
  + 'tools (server "sprite-studio") for art; GPU handoff before its jobs is automatic. Call gpu_status if a local model or '
  + 'a job is slow, and free_gpu before working by hand in Sprite Studio, ComfyUI or the Ollama app.'

async function call(name, args = {}) {
  if (name === 'gpu_status') return JSON.stringify(await gpuStatus(), null, 1)
  if (name === 'free_gpu') {
    if (args.for === 'art') {
      const unloaded = await unloadOllama({ everything: true })
      return unloaded.length ? `Unloaded Ollama model(s): ${unloaded.join(', ')}.` : 'No Ollama models were loaded.'
    }
    if (args.for === 'llm') {
      const freed = await freeComfy({ force: true })
      return freed ? `ComfyUI unloaded its models and caches (${(freed.after / 2 ** 30).toFixed(1)} GB of VRAM free).`
        : 'ComfyUI is busy or not reachable; try again when its queue is empty.'
    }
    throw new Error('for must be "art" or "llm"')
  }
  throw new Error(`unknown tool ${name}`)
}

const send = message => process.stdout.write(JSON.stringify(message) + '\n')

async function handle(message) {
  const { id, method, params = {} } = message
  if (id === undefined || id === null) return                       // notifications (initialized, cancelled)
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'gpu', version: '1.0.0' }, instructions: INSTRUCTIONS } })
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    if (method === 'tools/call') {
      try {
        const text = await call(params.name, params.arguments)
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
      } catch (error) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error.message ?? error) }], isError: true } })
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error.message ?? error) } })
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
  void handle(message)
})
