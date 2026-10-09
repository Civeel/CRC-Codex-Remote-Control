import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyScope } from '../permission-scope.mjs';

const listing = "Get-ChildItem -LiteralPath 'C:\\Windows\\Temp' -File -Force -ErrorAction Stop | Select-Object -First 5 -ExpandProperty Name";
test('recognizes literal directory listing without broadening shell permissions', () => {
  assert.deepEqual(readOnlyScope(listing), { readOnly:true, readPaths:['C:\\Windows\\Temp'], limit:5 });
  for (const command of [listing + '; Remove-Item foo', listing + ' | Set-Content foo', listing.replace('-File', '-Recurse'), listing.replace('-ExpandProperty Name', '-ExpandProperty { Remove-Item foo }'), listing.replace("'C:\\Windows\\Temp'", '"$(Remove-Item foo)"'), 'npm install']) {
    assert.equal(readOnlyScope(command).readOnly, false, command);
  }
});
