import { DatabaseSync } from 'node:sqlite';

export class ModelJournal {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS model_writes (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (host_id, thread_id))');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS recovery_writes (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, attempt_id TEXT, PRIMARY KEY(host_id,thread_id))');
      this.db.exec('CREATE TABLE IF NOT EXISTS message_writes (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, operation_id TEXT NOT NULL, phase TEXT NOT NULL, PRIMARY KEY(host_id,thread_id), UNIQUE(host_id,operation_id))');
      const columns = this.db.prepare('PRAGMA table_info(model_writes)').all().map(column => column.name);
      if (!columns.includes('operation_id')) this.db.exec('ALTER TABLE model_writes ADD COLUMN operation_id TEXT');
      if (!columns.includes('phase')) this.db.exec("ALTER TABLE model_writes ADD COLUMN phase TEXT NOT NULL DEFAULT 'unknown'");
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw error;
    }
  }
  begin(hostId, threadId, deviceId, operationId) {
    if (![hostId, threadId, deviceId, operationId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw new TypeError('Invalid model write identity');
    return this.db.prepare("INSERT OR IGNORE INTO model_writes (host_id,thread_id,device_id,operation_id,phase) SELECT ?,?,?,?,'prepared' WHERE NOT EXISTS (SELECT 1 FROM recovery_writes WHERE host_id=? AND thread_id=?) AND NOT EXISTS (SELECT 1 FROM message_writes WHERE host_id=? AND thread_id=?)").run(hostId, threadId, deviceId, operationId, hostId, threadId, hostId, threadId).changes === 1;
  }
  get(hostId, threadId) { return this.db.prepare('SELECT device_id AS deviceId,operation_id AS operationId,phase FROM model_writes WHERE host_id = ? AND thread_id = ?').get(hostId, threadId) || null; }
  dispatch(hostId, threadId, deviceId, operationId) { return this.db.prepare("UPDATE model_writes SET phase='dispatching' WHERE host_id=? AND thread_id=? AND device_id=? AND operation_id=? AND phase='prepared'").run(hostId, threadId, deviceId, operationId).changes === 1; }
  cancelPrepared(hostId, threadId, deviceId, operationId) { return this.db.prepare("DELETE FROM model_writes WHERE host_id=? AND thread_id=? AND device_id=? AND operation_id=? AND phase='prepared'").run(hostId, threadId, deviceId, operationId).changes === 1; }
  complete(hostId, threadId, deviceId, operationId) { return this.db.prepare("DELETE FROM model_writes WHERE host_id=? AND thread_id=? AND device_id=? AND operation_id=? AND phase='dispatching'").run(hostId, threadId, deviceId, operationId).changes === 1; }
  close() { this.db.close(); }
}
