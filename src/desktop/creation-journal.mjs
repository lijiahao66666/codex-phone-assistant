import { DatabaseSync } from 'node:sqlite';

// The database is local to the assistant; tokens and message contents are not stored.
export class CreationJournal {
  constructor(path, { coordinateWritesForTests = false } = {}) {
    if (typeof coordinateWritesForTests !== 'boolean') throw new TypeError('invalid experimental gate option');
    this.coordinateWritesForTests = coordinateWritesForTests;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec(`CREATE TABLE IF NOT EXISTS creations (host_id TEXT NOT NULL, device_id TEXT NOT NULL, request_id TEXT NOT NULL, project_id TEXT NOT NULL, payload_digest TEXT NOT NULL, phase TEXT NOT NULL, thread_id TEXT, PRIMARY KEY(host_id, device_id, request_id))`);
      this.db.exec('CREATE TABLE IF NOT EXISTS recovery_writes (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, attempt_id TEXT, PRIMARY KEY(host_id, thread_id))');
      if (!this.db.prepare('PRAGMA table_info(recovery_writes)').all().some(column => column.name === 'attempt_id')) this.db.exec('ALTER TABLE recovery_writes ADD COLUMN attempt_id TEXT');
      if (!this.db.prepare('PRAGMA table_info(recovery_writes)').all().some(column => column.name === 'created_at')) this.db.exec('ALTER TABLE recovery_writes ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
      for (const [name, type] of [['execution_id', 'TEXT'], ['execution_pid', 'INTEGER'], ['execution_started', 'TEXT']]) {
        if (!this.db.prepare('PRAGMA table_info(recovery_writes)').all().some(column => column.name === name)) this.db.exec(`ALTER TABLE recovery_writes ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('CREATE TABLE IF NOT EXISTS recovery_attempts (host_id TEXT NOT NULL, device_id TEXT NOT NULL, request_id TEXT NOT NULL, thread_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(host_id,device_id,request_id))');
      for (const [name, type] of [['execution_id', 'TEXT'], ['execution_pid', 'INTEGER'], ['execution_started', 'TEXT']]) {
        if (!this.db.prepare('PRAGMA table_info(recovery_attempts)').all().some(column => column.name === name)) this.db.exec(`ALTER TABLE recovery_attempts ADD COLUMN ${name} ${type}`);
      }
      this.db.exec('CREATE TABLE IF NOT EXISTS message_writes (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, operation_id TEXT NOT NULL, phase TEXT NOT NULL, PRIMARY KEY(host_id,thread_id), UNIQUE(host_id,operation_id))');
      this.db.exec('CREATE TABLE IF NOT EXISTS model_writes (host_id TEXT NOT NULL, thread_id TEXT NOT NULL, device_id TEXT NOT NULL, operation_id TEXT, phase TEXT NOT NULL DEFAULT \'unknown\', PRIMARY KEY(host_id,thread_id))');
      this.db.exec('CREATE TABLE IF NOT EXISTS raw_request_experiment (instance TEXT NOT NULL, request_key TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL, item TEXT NOT NULL, method TEXT NOT NULL, digest TEXT NOT NULL, phase TEXT NOT NULL, PRIMARY KEY(instance,request_key))');
      if (!this.db.prepare('PRAGMA table_info(raw_request_experiment)').all().some(column => column.name === 'host_id')) this.db.exec("ALTER TABLE raw_request_experiment ADD COLUMN host_id TEXT NOT NULL DEFAULT ''");
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS recovery_attempt_identity ON recovery_attempts(host_id,request_id)');
      if (coordinateWritesForTests) this.db.exec(`CREATE TABLE IF NOT EXISTS local_write_gate_experiment (
        host TEXT NOT NULL, thread TEXT NOT NULL, operation TEXT NOT NULL,
        phase TEXT NOT NULL, owner TEXT NOT NULL, generation TEXT NOT NULL, turn TEXT,
        PRIMARY KEY(host, thread), UNIQUE(host, operation))`);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw error;
    }
  }
  beginRecoveryAttempt(hostId, deviceId, threadId, requestId) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (![hostId, deviceId, threadId, requestId].every(value => typeof value === 'string' && uuid.test(value))) throw new TypeError('invalid recovery request identity');
    const inserted = this.db.prepare("INSERT OR IGNORE INTO recovery_attempts (host_id,device_id,request_id,thread_id,status) VALUES (?,?,?,?,'registered')").run(hostId, deviceId, requestId, threadId).changes === 1;
    const record = this.db.prepare('SELECT device_id AS deviceId,thread_id AS threadId,status FROM recovery_attempts WHERE host_id=? AND request_id=?').get(hostId, requestId);
    if (record.deviceId !== deviceId || record.threadId !== threadId) throw new Error('recovery request belongs to another device or thread');
    return { inserted, status: ['registered', 'dispatching'].includes(record.status) ? 'pending' : record.status };
  }
  cancelUnseenRecovery(hostId, deviceId, threadId, requestId) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (![hostId, deviceId, threadId, requestId].every(value => typeof value === 'string' && uuid.test(value))) throw new TypeError('invalid recovery request identity');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const record = this.db.prepare('SELECT device_id AS deviceId, thread_id AS threadId, status FROM recovery_attempts WHERE host_id=? AND request_id=?').get(hostId, requestId);
      if (record && (record.deviceId !== deviceId || record.threadId !== threadId)) throw new Error('recovery request belongs to another device or thread');
      if (this.recoveryPending(hostId, threadId) || (record && !['cancelled', 'registered'].includes(record.status))) { this.db.exec('COMMIT'); return false; }
      if (!record) this.db.prepare("INSERT INTO recovery_attempts (host_id,device_id,request_id,thread_id,status) VALUES (?,?,?,?,'cancelled')").run(hostId, deviceId, requestId, threadId);
      else if (record.status === 'registered') this.db.prepare("UPDATE recovery_attempts SET status='cancelled' WHERE host_id=? AND device_id=? AND thread_id=? AND request_id=? AND status='registered'").run(hostId, deviceId, threadId, requestId);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoveryAttempt(hostId, deviceId, threadId, requestId) {
    const row = this.db.prepare('SELECT status FROM recovery_attempts WHERE host_id=? AND device_id=? AND thread_id=? AND request_id=?').get(hostId, deviceId, threadId, requestId);
    return ['registered', 'dispatching'].includes(row?.status) ? 'pending' : row?.status || 'missing';
  }
  recoveryAttemptExecutionTracked(hostId, deviceId, threadId, requestId) {
    const row = this.db.prepare('SELECT execution_id,execution_pid,execution_started FROM recovery_attempts WHERE host_id=? AND device_id=? AND thread_id=? AND request_id=?').get(hostId, deviceId, threadId, requestId);
    if (!row) return null;
    // Only entirely unattributed rows can use the confirmed-route fallback.
    return row.execution_id !== null || row.execution_pid !== null || row.execution_started !== null;
  }
  dispatchRecovery(hostId, deviceId, threadId, requestId, execution = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.coordinateWritesForTests && this.db.prepare('SELECT 1 FROM local_write_gate_experiment WHERE host=? AND thread=?').get(hostId, threadId)) {
        this.db.exec('ROLLBACK'); return false;
      }
      const changed = this.db.prepare("UPDATE recovery_attempts SET status='dispatching' WHERE host_id=? AND device_id=? AND thread_id=? AND request_id=? AND status='registered'").run(hostId, deviceId, threadId, requestId).changes;
      if (!changed || !this.beginRecovery(hostId, threadId, requestId, execution)) { this.db.exec('ROLLBACK'); return false; }
      if (execution) this.db.prepare('UPDATE recovery_attempts SET execution_id=?, execution_pid=?, execution_started=? WHERE host_id=? AND device_id=? AND thread_id=? AND request_id=?').run(execution.instanceId, execution.pid, execution.startedAt, hostId, deviceId, threadId, requestId);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finishRecoveryAttempt(hostId, deviceId, threadId, requestId, status) {
    if (!['accepted', 'rejected'].includes(status)) throw new TypeError('invalid recovery status');
    return this.db.prepare("UPDATE recovery_attempts SET status=? WHERE host_id=? AND device_id=? AND thread_id=? AND request_id=? AND status IN ('registered','dispatching','pending')").run(status, hostId, deviceId, threadId, requestId).changes === 1;
  }
  rejectLateRecovery(hostId, deviceId, threadId, requestId) {
    return this.completeRecovery(hostId, deviceId, threadId, requestId, 'rejected');
  }
  completeRecovery(hostId, deviceId, threadId, requestId, status) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.finishRecoveryAttempt(hostId, deviceId, threadId, requestId, status);
      if (!changed || !this.endRecovery(hostId, threadId, requestId)) { this.db.exec('ROLLBACK'); return false; }
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoveryPending(hostId, threadId) {
    // A timeout cannot prove the app-server stopped executing the resume.
    return Boolean(this.db.prepare('SELECT 1 FROM recovery_writes WHERE host_id=? AND thread_id=?').get(hostId, threadId));
  }
  threadWritePending(hostId, threadId) {
    if (![hostId, threadId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw new TypeError('invalid thread write identity');
    // Model/message rows remain until their dispatched outcome is confirmed.
    // Legacy raw rows with an empty host or thread cover every matching scope.
    return Boolean(this.db.prepare("SELECT EXISTS (SELECT 1 FROM message_writes WHERE host_id=? AND thread_id=?) OR EXISTS (SELECT 1 FROM model_writes WHERE host_id=? AND thread_id=?) OR EXISTS (SELECT 1 FROM raw_request_experiment WHERE phase != 'resolved' AND (host_id=? OR host_id='') AND (thread=? OR thread='')) AS pending").get(hostId, threadId, hostId, threadId, hostId, threadId).pending);
  }
  recoveryExecutions(hostId) {
    return this.db.prepare("SELECT execution_id AS instanceId, execution_pid AS pid, execution_started AS startedAt FROM recovery_writes WHERE host_id=? AND execution_id IS NOT NULL UNION SELECT execution_id AS instanceId, execution_pid AS pid, execution_started AS startedAt FROM recovery_attempts WHERE host_id=? AND execution_id IS NOT NULL AND status IN ('registered','dispatching','pending','accepted')").all(hostId, hostId);
  }
  retireRecoveryExecution(hostId, execution) {
    if (!execution || typeof execution.instanceId !== 'string' || !execution.instanceId || !Number.isInteger(execution.pid) || execution.pid <= 1) throw new TypeError('invalid recovery execution');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare('SELECT thread_id AS threadId, attempt_id AS attemptId FROM recovery_writes WHERE host_id=? AND execution_id=? AND execution_pid=? AND execution_started IS ?').all(hostId, execution.instanceId, execution.pid, execution.startedAt ?? null);
      const retired = [];
      for (const row of rows) {
        const removed = this.db.prepare('DELETE FROM recovery_writes WHERE host_id=? AND thread_id=? AND attempt_id IS ? AND execution_id=? AND execution_pid=? AND execution_started IS ?').run(hostId, row.threadId, row.attemptId, execution.instanceId, execution.pid, execution.startedAt ?? null).changes;
        if (!removed) continue;
        this.db.prepare("UPDATE recovery_attempts SET status='rejected' WHERE host_id=? AND thread_id=? AND request_id=? AND execution_id=? AND execution_pid=? AND execution_started IS ? AND status IN ('registered','dispatching','pending')").run(hostId, row.threadId, row.attemptId, execution.instanceId, execution.pid, execution.startedAt ?? null);
        retired.push({ ...row });
      }
      this.db.prepare("UPDATE recovery_attempts SET status=CASE WHEN status='accepted' THEN 'released' ELSE 'rejected' END WHERE host_id=? AND execution_id=? AND execution_pid=? AND execution_started IS ? AND status IN ('registered','dispatching','pending','accepted') AND NOT EXISTS (SELECT 1 FROM recovery_writes WHERE recovery_writes.host_id=recovery_attempts.host_id AND recovery_writes.thread_id=recovery_attempts.thread_id AND recovery_writes.attempt_id=recovery_attempts.request_id)").run(hostId, execution.instanceId, execution.pid, execution.startedAt ?? null);
      this.db.exec('COMMIT');
      return retired;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  beginRecovery(hostId, threadId, attemptId = null, execution = null) {
    if (![hostId, threadId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw new TypeError('invalid recovery identity');
    if (attemptId !== null && (typeof attemptId !== 'string' || !attemptId || attemptId.length > 200)) throw new TypeError('invalid recovery attempt');
    if (execution !== null && (typeof execution?.instanceId !== 'string' || !execution.instanceId || !Number.isInteger(execution.pid) || execution.pid <= 1 || (execution.startedAt !== null && (typeof execution.startedAt !== 'string' || !execution.startedAt)))) throw new TypeError('invalid recovery execution');
    return this.db.prepare("INSERT OR IGNORE INTO recovery_writes (host_id,thread_id,attempt_id,created_at,execution_id,execution_pid,execution_started) SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM message_writes WHERE host_id=? AND thread_id=?) AND NOT EXISTS (SELECT 1 FROM model_writes WHERE host_id=? AND thread_id=?) AND NOT EXISTS (SELECT 1 FROM raw_request_experiment WHERE phase != 'resolved' AND (host_id=? OR host_id='') AND (thread=? OR thread=''))").run(hostId, threadId, attemptId, Date.now(), execution?.instanceId ?? null, execution?.pid ?? null, execution?.startedAt ?? null, hostId, threadId, hostId, threadId, hostId, threadId).changes === 1;
  }
  endRecovery(hostId, threadId, attemptId = null) { return this.db.prepare('DELETE FROM recovery_writes WHERE host_id=? AND thread_id=? AND attempt_id IS ?').run(hostId, threadId, attemptId).changes === 1; }
  beginMessage(hostId, threadId, operationId) {
    if (![hostId, threadId, operationId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) throw new TypeError('invalid message identity');
    return this.db.prepare("INSERT OR IGNORE INTO message_writes (host_id,thread_id,operation_id,phase) SELECT ?,?,?,'prepared' WHERE NOT EXISTS (SELECT 1 FROM recovery_writes WHERE host_id=? AND thread_id=?) AND NOT EXISTS (SELECT 1 FROM model_writes WHERE host_id=? AND thread_id=?)").run(hostId, threadId, operationId, hostId, threadId, hostId, threadId).changes === 1;
  }
  dispatchMessage(hostId, threadId, operationId) {
    return this.db.prepare("UPDATE message_writes SET phase='dispatching' WHERE host_id=? AND thread_id=? AND operation_id=? AND phase='prepared'").run(hostId, threadId, operationId).changes === 1;
  }
  endMessage(hostId, threadId, operationId, phase) {
    if (!['prepared', 'dispatching'].includes(phase)) throw new TypeError('invalid message phase');
    return this.db.prepare('DELETE FROM message_writes WHERE host_id=? AND thread_id=? AND operation_id=? AND phase=?').run(hostId, threadId, operationId, phase).changes === 1;
  }
  listThreadIds(hostId) {
    if (typeof hostId !== 'string' || !hostId || hostId.length > 200) throw new TypeError('invalid host identity');
    return this.db.prepare("SELECT DISTINCT thread_id AS id FROM creations WHERE host_id=? AND thread_id IS NOT NULL AND phase IN ('prepared','submitting','submitted')").all(hostId)
      .map(row => row.id).filter(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  }
  get(hostId, deviceId, requestId) { return this.db.prepare('SELECT project_id AS projectId, payload_digest AS payloadDigest, phase, thread_id AS threadId FROM creations WHERE host_id=? AND device_id=? AND request_id=?').get(hostId, deviceId, requestId) || null; }
  begin(hostId, deviceId, requestId, projectId, payloadDigest) {
    if (![hostId, deviceId, requestId, projectId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200) || !/^[a-f0-9]{64}$/.test(payloadDigest || '')) throw new TypeError('invalid creation identity');
    const result = this.db.prepare("INSERT OR IGNORE INTO creations VALUES (?, ?, ?, ?, ?, 'creating', NULL)").run(hostId, deviceId, requestId, projectId, payloadDigest);
    const record = this.get(hostId, deviceId, requestId);
    if (record.projectId !== projectId || record.payloadDigest !== payloadDigest) throw new Error('request id belongs to another payload');
    return { created: result.changes === 1, ...record };
  }
  transition(hostId, deviceId, requestId, from, to, threadId) {
    const allowed = new Set(['creating:prepared', 'prepared:submitting', 'submitting:submitted']);
    if (!allowed.has(`${from}:${to}`)) throw new TypeError('invalid transition');
    if (to === 'prepared' && (typeof threadId !== 'string' || !threadId)) throw new TypeError('threadId required');
    const result = this.db.prepare('UPDATE creations SET phase=?, thread_id=COALESCE(?,thread_id) WHERE host_id=? AND device_id=? AND request_id=? AND phase=?').run(to, threadId ?? null, hostId, deviceId, requestId, from);
    if (result.changes !== 1) throw new Error('creation state changed');
    return this.get(hostId, deviceId, requestId);
  }
  close() { this.db.close(); }
}
