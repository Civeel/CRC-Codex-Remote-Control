export class MobilePresence {
  constructor({ ttlMs = 7000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.connections = new Map();
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
}
