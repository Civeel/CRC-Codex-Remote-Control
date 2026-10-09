import test from 'node:test';
import assert from 'node:assert/strict';
import { MobilePresence } from '../mobile-presence.mjs';

test('mobile is online only after a heartbeat on a connected page, and expires on packet loss', () => {
  let now=0;
  const presence=new MobilePresence({ttlMs:7000,now:()=>now});
  assert.equal(presence.heartbeat('missing'),false);
  presence.connect('phone');
  assert.equal(presence.online(),false);
  presence.heartbeat('phone');
  assert.equal(presence.online(),true);
  now=6999; assert.equal(presence.online(),true);
  now=7000; assert.equal(presence.online(),false);
});

test('one disconnected phone does not override another phone or a newer stream', () => {
  const presence=new MobilePresence();
  const oldStream={}, newStream={};
  presence.connect('one',oldStream); presence.heartbeat('one');
  presence.connect('two'); presence.heartbeat('two');
  presence.disconnect('one',oldStream); assert.equal(presence.online(),true);
  presence.pause('two'); assert.equal(presence.online(),false);
  presence.connect('one',newStream); presence.heartbeat('one');
  presence.disconnect('one',oldStream); assert.equal(presence.online(),true);
  presence.disconnect('one',newStream); assert.equal(presence.online(),false);
});
