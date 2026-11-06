import { applyPatches, enablePatches } from 'immer';

enablePatches();
function statusFits(value) {
  try { return JSON.stringify(value?.threadRuntimeStatus)?.length <= 4096 || value?.threadRuntimeStatus === undefined; }
  catch { return false; }
}

// Keep only the field needed by the sidebar, while tracking the full stream revision.
export class SidebarProjection {
  invalidate(reason) {
    this.ownerId = null; this.revision = null; this.value = null;
    return { status: 'invalid', reason };
  }
  accept(ownerId, change) {
    if (typeof ownerId !== 'string' || !ownerId || !change || typeof change !== 'object') return this.invalidate('invalid-message');
    if (change.type === 'snapshot') {
      if (this.ownerId && this.ownerId !== ownerId) return this.invalidate('owner-changed');
      if (!Number.isSafeInteger(change.revision) || change.revision < 0 || !change.conversationState || typeof change.conversationState !== 'object' || Array.isArray(change.conversationState)) return this.invalidate('invalid-snapshot');
      if (this.revision !== null && this.revision !== undefined && change.revision < this.revision) return this.invalidate('revision-gap');
      try { this.value = { threadRuntimeStatus: structuredClone(change.conversationState.threadRuntimeStatus) }; }
      catch { return this.invalidate('invalid-snapshot'); }
      if (!statusFits(this.value)) return this.invalidate('status-too-large');
      this.ownerId = ownerId; this.revision = change.revision;
      return { status: 'ready', value: this.value };
    }
    if (change.type !== 'patches') return this.invalidate('unknown-change');
    if (!this.value) return this.invalidate('snapshot-required');
    if (ownerId !== this.ownerId) return this.invalidate('owner-changed');
    if (change.baseRevision !== this.revision || !Number.isSafeInteger(change.revision) || change.revision <= this.revision || !Array.isArray(change.patches)) return this.invalidate('revision-gap');
    try {
      let value = this.value;
      for (const patch of change.patches) {
        if (!patch || !['add', 'replace', 'remove'].includes(patch.op) || !Array.isArray(patch.path)) return this.invalidate('invalid-patches');
        if (!patch.path.length) {
          if (patch.op === 'remove' || !patch.value || typeof patch.value !== 'object' || Array.isArray(patch.value)) return this.invalidate('invalid-state');
          value = { threadRuntimeStatus: structuredClone(patch.value.threadRuntimeStatus) };
        } else if (patch.path[0] === 'threadRuntimeStatus') value = applyPatches(value, [patch]);
      }
      if (!statusFits(value)) return this.invalidate('status-too-large');
      this.value = value; this.revision = change.revision;
      return { status: 'ready', value };
    } catch { return this.invalidate('invalid-patches'); }
  }
}
