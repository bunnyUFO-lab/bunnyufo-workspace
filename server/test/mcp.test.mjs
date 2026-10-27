import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { McpInventory } from '../mcp.mjs';

async function fixture(options = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'buw-mcp-test-'));
  const repo = path.join(base, 'project'), home = path.join(base, 'home');
  for (const root of [repo, home]) for (const dir of ['.claude', '.codex', '.kimi-code', '.cursor']) await mkdir(path.join(root, dir), { recursive: true });
  const json = (file, value) => writeFile(file, JSON.stringify(value));
  const inventory = new McpInventory(repo, { home, env: { PATH: process.env.PATH, APPDATA: path.join(home, 'appdata') }, ...options });
  return { repo, home, json, inventory };
}

test('MCP sources preserve agent precedence without exposing credentials or URL secrets', async () => {
  const { repo, home, json, inventory } = await fixture();
  await json(path.join(repo, '.mcp.json'), { mcpServers: { service: { url: 'https://project.example/mcp' } } });
  await json(path.join(home, '.claude.json'), { mcpServers: { service: { url: 'https://global.example/mcp' } }, projects: { [repo]: { mcpServers: { service: { url: 'https://user:password@local.example/secret-path?token=url-secret', headers: { Authorization: 'header-secret' } } } }, other: { mcpServers: { invisible: { url: 'https://other.example' } } } } });
  await writeFile(path.join(home, '.codex/config.toml'), '[mcp_servers.service]\nurl="https://global.example/mcp"\nenabled=false\nhttp_headers={Authorization="codex-secret"}\n');
  await writeFile(path.join(repo, '.codex/config.toml'), '[mcp_servers.service]\nurl="https://project.example/mcp"\nenabled=true\n');
  const result = await inventory.list();
  const claude = result.servers.find(item => item.client === 'claude'), codex = result.servers.find(item => item.client === 'codex');
  assert.equal(claude.scope, 'local'); assert.equal(claude.endpoint, 'https://local.example'); assert.equal(claude.sources.length, 3);
  assert.equal(codex.scope, 'project'); assert.equal(codex.enabled, true); assert.equal(codex.sources.length, 2);
  for (const secret of ['password','secret-path','url-secret','header-secret','codex-secret','invisible']) assert.equal(JSON.stringify(result).includes(secret), false);
});

test('MCP discovery distinguishes declared disabled plugins, missing programs, keys and project approval', async () => {
  const { repo, home, json, inventory } = await fixture();
  await json(path.join(repo, '.mcp.json'), { mcpServers: {
    key: { url: 'https://example.test', headers: { Authorization: '${BUW_MCP_TEST_KEY:-}' } },
    absent: { command: 'missing-buw-fixture-executable' },
    approval: { url: 'https://example.test/mcp' },
  } });
  await writeFile(path.join(home, '.codex/config.toml'), '[plugins."example@fixture"]\nenabled=false\n');
  const plugin = path.join(home, '.codex/plugins/cache/fixture/example/1.0');
  await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true });
  await json(path.join(plugin, '.codex-plugin/plugin.json'), { mcpServers: './.mcp.json' });
  await json(path.join(plugin, '.mcp.json'), { mcpServers: { from_plugin: { command: process.execPath } } });
  const result = await inventory.list();
  assert.equal(result.servers.find(item => item.name === 'key').readiness, 'missing-env');
  assert.equal(result.servers.find(item => item.name === 'absent').readiness, 'missing-command');
  assert.equal(result.servers.find(item => item.name === 'approval').readiness, 'approval');
  const fromPlugin = result.servers.find(item => item.name === 'from_plugin');
  assert.equal(fromPlugin.enabled, false); assert.equal(fromPlugin.canCheck, false);
});

test('invalid configuration errors never quote their secret-bearing source', async () => {
  const { repo, inventory } = await fixture();
  await writeFile(path.join(repo,'.mcp.json'), '{"secret":"never-echo-this", broken');
  const result = await inventory.list();
  assert.equal(result.problems.length, 1); assert.equal(JSON.stringify(result).includes('never-echo-this'), false);
});

test('HTTP check initializes and lists tools without invoking a tool; auth failures are private', async () => {
  const { repo, json, inventory } = await fixture();
  const calls = []; let deny = false;
  const server = http.createServer(async (req, res) => {
    if (deny) { res.writeHead(401, { 'Content-Type':'application/json' }); res.end('{"error":"echo-private-header"}'); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString()); calls.push(message.method);
    if (message.id == null) { res.writeHead(202); res.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1.0'} } : { tools:[{name:'read_fixture',description:'Fixture',inputSchema:{type:'object'}}] };
    res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    await json(path.join(repo,'.mcp.json'), {mcpServers:{fixture:{url:`http://127.0.0.1:${server.address().port}/mcp`,headers:{Authorization:'echo-private-header'}}}});
    assert.deepEqual(await inventory.check('claude:fixture').then(({status,toolCount}) => ({status,toolCount})), {status:'available',toolCount:1});
    assert.deepEqual(calls, ['initialize','notifications/initialized','tools/list']);
    deny=true;
    const result = await inventory.check('claude:fixture');
    assert.equal(result.status,'agent-auth'); assert.equal(JSON.stringify(result).includes('echo-private-header'),false);
  } finally { inventory.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('stdio checks reap their private server process and never run a server tool', async () => {
  const { repo, json, inventory } = await fixture();
  const script = path.join(repo,'fixture.mjs'), pidFile=path.join(repo,'pid.txt'), callsFile=path.join(repo,'calls.txt');
  await writeFile(script, `import{createInterface}from'node:readline';import{writeFileSync,appendFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(${JSON.stringify(callsFile)},m.method+'\\n');if(m.id!=null)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]}}))});`);
  await json(path.join(repo,'.mcp.json'), {mcpServers:{fixture:{command:process.execPath,args:[script]}}});
  const result=await inventory.check('claude:fixture'); assert.equal(result.status,'available');
  const pid=Number(await readFile(pidFile,'utf8')); assert.throws(()=>process.kill(pid,0));
  assert.equal((await readFile(callsFile,'utf8')).includes('tools/call'),false);
});

test('checks are invalidated when credentials change and disabled servers cannot launch', async () => {
  let probes=0;
  const { repo, json, inventory } = await fixture({probe:async()=>{probes++;return{status:'available',toolCount:0}}});
  await json(path.join(repo,'.mcp.json'), {mcpServers:{fixture:{url:'https://example.test',headers:{Authorization:'${BUW_MCP_TEST_KEY:-}'}}}});
  await writeFile(path.join(repo,'.env'),'BUW_MCP_TEST_KEY=first-private-key\n');
  await inventory.check('claude:fixture'); assert.equal((await inventory.list()).servers[0].connection.status,'available');
  await writeFile(path.join(repo,'.env'),'BUW_MCP_TEST_KEY=second-private-key\n');
  assert.equal((await inventory.list()).servers[0].connection,null);
  await json(path.join(repo,'.mcp.json'), {mcpServers:{fixture:{url:'https://example.test',disabled:true}}});
  await assert.rejects(inventory.check('claude:fixture')); assert.equal(probes,1);
});
