import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DesktopCatalog, normalizeThread } from '../desktop-catalog.mjs';

test('desktop names and project directories are preserved without claiming live state', () => {
  assert.deepEqual(normalizeThread({id:'one',name:'桌面真实标题',preview:'旧提示',cwd:'C:\\Example\\OtherProject',updatedAt:123}), {
    id:'one',title:'桌面真实标题',cwd:'C:\\Example\\OtherProject',updatedAt:123000
  });
});

test('catalog pages stored conversations without starting or resuming tasks', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('exit',0);
  child.stdin.on('data', chunk => {
    const request = JSON.parse(chunk.toString());
    calls.push(request);
    if (!request.id) return;
    const result = request.method === 'initialize' ? {} : request.params.cursor
      ? {data:[{id:'two',name:'另一个对话',cwd:'C:\\Example\\OtherProject'}],nextCursor:null}
      : {data:[{id:'one',name:'当前对话',cwd:'C:\\Example\\CRC'}],nextCursor:'next'};
    const response = Buffer.from(JSON.stringify({id:request.id,result})+'\n');
    setImmediate(() => { child.stdout.write(response.subarray(0,50)); child.stdout.write(response.subarray(50)); });
  });
  const catalog = new DesktopCatalog({executable:process.execPath,spawnProcess:()=>child});
  try {
    await catalog.refresh();
    assert.equal(catalog.error,null);
    assert.deepEqual(catalog.items.map(item=>item.title),['当前对话','另一个对话']);
    assert.equal(catalog.items[1].cwd,'C:\\Example\\OtherProject');
    assert.deepEqual(calls.map(call=>call.method),['initialize','initialized','thread/list','thread/list']);
    assert.deepEqual(calls[2].params.sourceKinds,['cli','vscode','appServer']);
  } finally { catalog.close(); }
});
