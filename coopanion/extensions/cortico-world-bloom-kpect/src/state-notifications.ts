import {coreSections, eventVersion, stateEvent} from './observation';

type State = Record<string, any>;
export type StateWakeMode = 'important' | 'all' | 'off';
export type StateNotificationOptions = {now?: number; mode?: StateWakeMode; intervalSec?: number};
export type StateNotification = {
 data: NonNullable<ReturnType<typeof stateEvent>>;
 trigger: 'piggyback' | 'debounce';
 reason: 'snapshot' | 'important' | 'interval';
};
type DeliveryAttempt = {
 previous: State | null; previousAt: number; snapshotPending: boolean; retryImportant: boolean;
 deliveryRevision: number; acknowledgmentRevision: number;
};

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pick = (value: State, keys: string[]) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const list = (value: unknown): State[] => Array.isArray(value) ? value : [];

function personalTurns(version: State) {
 const id = version.me?.id;
 return list(version.parlor?.rooms)
  .filter(room => room.hostId === id || room.players?.includes(id) || room.myRole !== undefined)
  .map(room => pick(room, ['id', 'phase', 'round', 'turn', 'pending', 'myRole', 'myChecks', 'myVote', 'alive', 'result']))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function incoming(version: State) {
 const id = version.me?.id;
 return {
  letters: list(version.mailbox?.letters).filter(item => item.recipientId === id).map(item => pick(item, ['id'])),
  parcels: list(version.mailbox?.parcels).filter(item => item.recipientId === id).map(item => pick(item, ['id', 'status'])),
  visits: list(version.visits).filter(item => item.hostId === id || item.guestId === id).map(item => pick(item, ['id', 'status'])),
 };
}

/** Detect decision boundaries, not ticker changes, chat logs, or countdown ticks. */
function importantChange(previous: State, current: State) {
 if (previous.activeAction && (!current.activeAction || previous.activeAction.id !== current.activeAction.id)) return true;
 if (previous.me?.location !== undefined && previous.me.location !== current.me?.location) return true;
 const matureBefore = new Set(list(previous.plots).filter(plot => plot.mature).map(plot => plot.id));
 if (list(current.plots).some(plot => plot.mature && !matureBefore.has(plot.id))) return true;
 if (previous.parlor !== undefined && !equal(personalTurns(previous), personalTurns(current))) return true;
 if (previous.quiz !== undefined && !equal(pick(previous.quiz, ['day', 'open', 'songOpen', 'round']), pick(current.quiz, ['day', 'open', 'songOpen', 'round']))) return true;
 if ((previous.mailbox !== undefined || previous.visits !== undefined) && !equal(incoming(previous), incoming(current))) return true;
 return false;
}

/**
 * Observed state detects one-time transitions; delivered state accumulates the
 * latest undelivered changes. The caller keeps message polling independent.
 */
export class StateNotifications {
 private observed: State | null = null;
 private delivered: State | null = null;
 private deliveredAt = 0;
 private snapshotPending = true;
 private retryImportant = false;
 private deliveryRevision = 0;
 private acknowledgmentRevision = 0;
 private acknowledged = new Map<string, {revision: number; value: unknown}>();
 private attempts = new WeakMap<StateNotification, DeliveryAttempt>();

 reset() {
  this.observed = null; this.delivered = null; this.deliveredAt = 0;
  this.snapshotPending = true; this.retryImportant = false; this.deliveryRevision++;
  this.acknowledged.clear(); this.attempts = new WeakMap();
 }

 private deliver(notification: StateNotification, version: State, now: number) {
  this.attempts.set(notification, {
   previous: this.delivered === null ? null : structuredClone(this.delivered), previousAt: this.deliveredAt,
   snapshotPending: this.snapshotPending, retryImportant: this.retryImportant,
   deliveryRevision: ++this.deliveryRevision, acknowledgmentRevision: this.acknowledgmentRevision,
  });
  this.delivered = version; this.deliveredAt = now;
  this.snapshotPending = false; this.retryImportant = false;
  return notification;
 }

 /** A rejected push must not consume a change. Preserve any concurrent action
  * receipt, and ignore a late failure already superseded by a newer delivery. */
 reject(notification: StateNotification) {
  const attempt = this.attempts.get(notification);
  if (!attempt || attempt.deliveryRevision !== this.deliveryRevision) return;
  this.attempts.delete(notification); this.deliveryRevision++;
  let restored = attempt.previous;
  for (const [key, ack] of this.acknowledged) if (ack.revision > attempt.acknowledgmentRevision) {
   restored ??= {}; restored[key] = structuredClone(ack.value);
  }
  this.delivered = restored; this.deliveredAt = attempt.previousAt;
  this.snapshotPending = attempt.snapshotPending;
  this.retryImportant = attempt.retryImportant || notification.reason === 'important';
 }

 observe(state: State, options: StateNotificationOptions = {}): StateNotification | null {
  const {now = Date.now(), mode = 'important', intervalSec = 300} = options;
  if (!['important', 'all', 'off'].includes(mode)) throw new Error('stateWakeMode须为important、all或off');
  if (!Number.isFinite(intervalSec) || intervalSec < 15 || intervalSec > 3600) throw new Error('stateEventIntervalSec须为15至3600秒');
  const version = structuredClone(eventVersion(state, now));
  const previousObserved = this.observed;
  this.observed = version;
  if (this.snapshotPending) return this.deliver({data: stateEvent(state, null, version)!, trigger: 'piggyback', reason: 'snapshot'}, version, now);
  if (mode === 'off') {
   this.delivered = version;
   this.deliveredAt = now;
   this.retryImportant = false; this.deliveryRevision++;
   return null;
  }
  const change = stateEvent(state, this.delivered, version);
  if (!change) { this.retryImportant = false; return null; }
  const important = mode === 'important' && (this.retryImportant || previousObserved !== null && importantChange(previousObserved, version));
  if (!important && now - this.deliveredAt < intervalSec * 1000) return null;
  return this.deliver({data: change, trigger: 'debounce', reason: important ? 'important' : 'interval'}, version, now);
 }

 /** Confirm only chapters actually returned in compactReceipt/core. External
  * mail and other omitted chapters remain pending, even during our own action. */
 acknowledge(state: State, now = Date.now()) {
  const version = structuredClone(eventVersion(state, now));
  if (!this.observed) this.observed = {};
  if (!this.delivered) { this.delivered = {}; this.deliveredAt = now; }
  const revision = ++this.acknowledgmentRevision;
  for (const key of coreSections) {
   if (Object.hasOwn(state, key) && Object.hasOwn(version, key)) {
    this.observed[key] = version[key];
    this.delivered[key] = version[key];
    this.acknowledged.set(key, {revision, value: version[key]});
   }
  }
 }
}
