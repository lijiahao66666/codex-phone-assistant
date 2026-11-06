import { applyPatches, enablePatches, freeze } from 'immer';

enablePatches();

// A new owner requires a new snapshot before any patches are accepted.
export class ConversationState {
  #ownerId = null;
  #revision = null;
  #value = null;

  get value() { return this.#value; }
  get revision() { return this.#revision; }
  get ownerId() { return this.#ownerId; }

  invalidate(reason) {
    this.#ownerId = null;
    this.#revision = null;
    this.#value = null;
    return { status: 'invalid', reason };
  }

  accept(ownerId, change) {
    if (typeof ownerId !== 'string' || !ownerId || !change || typeof change !== 'object') {
      return this.invalidate('invalid-message');
    }
    if (change.type === 'snapshot') {
      if (this.#ownerId !== null && ownerId !== this.#ownerId) return this.invalidate('owner-changed');
      if (!Number.isSafeInteger(change.revision) || change.revision < 0 ||
          !change.conversationState || typeof change.conversationState !== 'object' || Array.isArray(change.conversationState)) {
        return this.invalidate('invalid-snapshot');
      }
      if (this.#revision !== null && change.revision < this.#revision) return this.invalidate('revision-gap');
      // Copy on entry so callers cannot mutate the accepted state through the event.
      try { this.#value = freeze(structuredClone(change.conversationState), true); }
      catch { return this.invalidate('invalid-snapshot'); }
      this.#ownerId = ownerId;
      this.#revision = change.revision;
      return { status: 'ready', revision: this.#revision, value: this.#value };
    }
    if (change.type !== 'patches') return this.invalidate('unknown-change');
    if (this.#value === null) return this.invalidate('snapshot-required');
    if (ownerId !== this.#ownerId) return this.invalidate('owner-changed');
    if (change.baseRevision !== this.#revision || !Number.isSafeInteger(change.revision) ||
        change.revision <= this.#revision) return this.invalidate('revision-gap');
    if (!Array.isArray(change.patches)) return this.invalidate('invalid-patches');
    try {
      this.#value = applyPatches(this.#value, change.patches);
      if (!this.#value || typeof this.#value !== 'object' || Array.isArray(this.#value)) {
        return this.invalidate('invalid-state');
      }
      this.#revision = change.revision;
      return { status: 'ready', revision: this.#revision, value: this.#value };
    } catch {
      return this.invalidate('invalid-patches');
    }
  }
}
