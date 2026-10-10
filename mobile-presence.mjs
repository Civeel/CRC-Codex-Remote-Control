export class MobilePresence {
  constructor({ ttlMs = 7000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.connections = new Map();
    this.remoteOwners = new Map();
  }
  connect(key, owner) { this.connections.set(key, { lastSeen:null, owner }); }
  heartbeat(key) {
    if (!this.connections.has(key)) return false;
    this.connections.get(key).lastSeen = this.now();
    return true;
  }
  pause(key) { if (this.connections.has(key)) this.connections.get(key).lastSeen = null; }
  disconnect(key, owner) {
    if (this.connections.get(key)?.owner === owner) this.connections.delete(key);
  }
  online() {
    for (const { lastSeen } of this.connections.values()) {
      if (lastSeen !== null && this.now() - lastSeen < this.ttlMs) return true;
    }
    return false;
  }
  setRemote(key, enabled, holdMs = 86400000) {
    if (enabled) this.remoteOwners.set(key, this.now() + holdMs);
    else this.remoteOwners.delete(key);
  }
  remote(key) {
    for (const [owner, deadline] of this.remoteOwners) if (deadline <= this.now()) this.remoteOwners.delete(owner);
    return key === undefined ? this.remoteOwners.size > 0 : this.remoteOwners.has(key);
  }
  remoteUntil(key) { return this.remote(key) ? this.remoteOwners.get(key) : null; }
}
