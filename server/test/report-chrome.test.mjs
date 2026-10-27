import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {reportChromeStream,serveReport} from '../report-chrome.mjs';
import {mkdtemp,writeFile,stat} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

async function rendered(chunks) {
  const result=[];
  for await(const chunk of Readable.from(chunks).pipe(reportChromeStream()))result.push(chunk);
  return Buffer.concat(result).toString('utf8');
}
const original = output => output.replace(/<meta name="color-scheme" content="dark"><style data-buw-chrome>[\s\S]*?<\/style><script data-buw-links>[\s\S]*?<\/script>/,'');
test('report chrome precedes document styles and preserves Unicode and original content across chunks', async()=>{
  const source='\uFEFF<!doctype html><html lang="en"><head><meta charset="utf-8"><style>body{background:#ddd}</style></head><body>Пример 🐽<pre>const head = "&lt;head&gt;";</pre></body></html>';
  const bytes=Buffer.from(source);
  const output=await rendered(Array.from(bytes,byte=>Buffer.from([byte])));
  assert.equal(original(output),source);
  assert.ok(output.indexOf('data-buw-chrome') < output.indexOf('body{background:#ddd}'));
  assert.ok(output.startsWith('\uFEFF<!doctype html>'));
  assert.match(output,/scrollbar-color:#514c59 #111217/);
});
test('unstyled fragments and large reports retain their content and receive one chrome layer',async()=>{
  for(const source of ['<h1>A plain report</h1>', '<!doctype html><h1>No explicit head</h1>', '<!doctype html><!--'+'x'.repeat(70000)+'--><html><body>Large report</body></html>']){
    const output=await rendered([Buffer.from(source.slice(0,65000)),Buffer.from(source.slice(65000))]);
    assert.equal(original(output),source); assert.equal(output.split('data-buw-chrome').length,2);
    if(source.startsWith('<!doctype'))assert.ok(output.startsWith('<!doctype html>'));
  }
});

test('HTML GET and HEAD agree on byte length while ranges remain full transformed documents',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'buw-report-'));
  const file=path.join(dir,'report.html'),source='<!doctype html><html><head></head><body>Пример 🐽</body></html>';
  await writeFile(file,source); const info=await stat(file);
  const server=http.createServer((request,response)=>{void serveReport(request,response,file,info,{});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const url=`http://127.0.0.1:${server.address().port}/report.html`;
    const head=await fetch(url,{method:'HEAD'}),get=await fetch(url),body=Buffer.from(await get.arrayBuffer());
    assert.equal(Number(head.headers.get('content-length')),body.length);
    assert.equal(Number(get.headers.get('content-length')),body.length);
    assert.equal(original(body.toString('utf8')),source);
    assert.match(get.headers.get('content-type'),/^text\/html/);
    const range=await fetch(url,{headers:{Range:'bytes=0-10'}});
    assert.equal(range.status,200); assert.equal(original(await range.text()),source);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
