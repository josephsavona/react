/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

/**
 * possible states:
 * - no pending work
 * - pending high-priority event
 * - pending continuous event
 * - pending transition
 *
 * events:
 * - discrete event
 * - continuous event
 * - non-event (eg network response, other host API callback)
 *
 * Simplify: high-pri events flush immediately and synchronously.
 * Background updates keep going and complete eventually.
 */
// ...
import type {AnyValue, AwaitElement, ComputeValue} from './FirTypes';
import type {LowPriTransitionState} from './FirWorkloop';

import {FLAG_INACTIVE} from './FirTypes';
import {
  runLowPriUpdate,
  runSynchronizationPhase,
  runCommitPhase,
  runPassiveEffects,
  hasFlag,
} from './FirWorkloop';

let activeTransition: Transition | null = null;
let pendingLowPriTransition: LowPriTransition | null = null;
let queuedTransition: LowPriTransition | DefaultTransition | null = null;

type Transition = SyncTransition | DefaultTransition | LowPriTransition;
export type UpdateQueue = Array<PendingUpdate>;
export type PendingUpdate = {compute: ComputeValue<AnyValue>, value: AnyValue};

type SyncTransition = {
  kind: 'sync',
  queue: UpdateQueue,
};
type DefaultTransition = {
  kind: 'default',
  queue: UpdateQueue,
};
export type LowPriTransition = {
  kind: 'lowpri',
  queue: UpdateQueue,
  state: LowPriTransitionState,
  pendingCount: number,
};

export function enqueueUpdate<T>(
  compute: ComputeValue<T>,
  value: T | (T => T),
): void {
  if (hasFlag(compute.state, FLAG_INACTIVE)) {
    console.warn(`setState called on an unmounted component`);
    return;
  }
  const entry = {compute, value};
  let transition = activeTransition;
  if (transition == null) {
    transition = startDefaultTransition();
  }
  transition.queue.push(entry);

  if (
    pendingLowPriTransition != null &&
    pendingLowPriTransition !== transition
  ) {
    pendingLowPriTransition.queue.push(entry);
  }
}

export function queuePendingPromise<T>(
  listener: AwaitElement<T>,
  promise: Promise<T>,
): void {
  if (pendingLowPriTransition != null) {
    pendingLowPriTransition.pendingCount++;
  }
}

export function resolvePendingPromise<T>(
  listener: AwaitElement<T>,
  promise: Promise<T>,
): void {
  if (pendingLowPriTransition != null) {
    pendingLowPriTransition.pendingCount--;
  }
}

export function ensureActiveTransition(): void {
  if (activeTransition == null) {
    startDefaultTransition();
  }
}

function startDefaultTransition(): DefaultTransition {
  if (activeTransition != null) {
    throw new Error('Already an active transition');
  }
  const transition: DefaultTransition = {kind: 'default', queue: []};
  activeTransition = transition;
  queueDefaultTransition(transition, 0, false);
  return transition;
}

function queueDefaultTransition(
  transition: DefaultTransition,
  previousIterationCount: number,
  previousHasChanges: boolean,
): void {
  console.log('queueDefaultTransition (microtask)');
  queuedTransition = transition;
  queueMicrotask(() => {
    if (queuedTransition !== transition) {
      return;
    }
    queuedTransition = null;
    let iterationCount = previousIterationCount;
    let hasChanges = previousHasChanges;
    while (transition.queue.length !== 0) {
      if (iterationCount++ > 1000) {
        throw new Error('Infinite setState in render loop');
      }
      const queue = transition.queue;
      transition.queue = [];
      const queueHasChanges = runSynchronizationPhase(queue);
      hasChanges ||= queueHasChanges;
    }
    if (iterationCount !== previousIterationCount) {
      // If updates occurred in this iteration, try delaying again
      // to see if there are more updates. This ensures that for each
      // suspense we'll wait one microtask to see if resolves "synchronously"
      queueDefaultTransition(transition, iterationCount, hasChanges);
    } else if (hasChanges) {
      // If nothing changed this iteration then updates are settled and we
      // commit what we have (which may mean showing a fallback).
      // Commit and run effects.
      // NOTE: in the future effects should run at lower priority
      runCommitPhase();
      runPassiveEffects();
      activeTransition = null;
      if (pendingLowPriTransition != null) {
        queueLowPriTransition(pendingLowPriTransition);
      }
    } else {
      activeTransition = null;
      if (pendingLowPriTransition != null) {
        queueLowPriTransition(pendingLowPriTransition);
      }
    }
  });
}

export function flushSync(cb: () => void): void {
  const parentTransition = activeTransition;
  const queue: UpdateQueue = [];
  if (parentTransition != null) {
    if (parentTransition.kind === 'sync') {
      // We're already in a flush sync transition
      cb();
      return;
    } else if (parentTransition.kind === 'default') {
      // Add any unprocessed updates and cancel any pending transition
      queue.push(...parentTransition.queue);
      queuedTransition = null;
    }
  }
  const transition: SyncTransition = {kind: 'sync', queue};
  activeTransition = transition;
  cb();
  let iterationCount = 0;
  let hasChanges = false;
  while (transition.queue.length !== 0) {
    if (iterationCount++ > 1000) {
      throw new Error('Infinite setState in render loop');
    }
    const queue = transition.queue;
    transition.queue = [];
    const queueHasChanges = runSynchronizationPhase(queue);
    hasChanges ||= queueHasChanges;
  }
  if (hasChanges) {
    runCommitPhase();
    runPassiveEffects();
  }
  activeTransition = parentTransition;

  if (pendingLowPriTransition != null) {
    queueLowPriTransition(pendingLowPriTransition);
  }
}

export function startTransition(cb: () => void): void {
  const parentTransition = activeTransition;
  if (parentTransition != null) {
    if (parentTransition.kind === 'lowpri') {
      // If we're already executing in the context of a low-pri update
      // then we can just immediately execute and the initiator of the transition
      // will deal with running the queue etc
      cb();
      return;
    } // else we will restore the current transition before returning
  }
  let transition: LowPriTransition;
  if (pendingLowPriTransition != null) {
    transition = pendingLowPriTransition;
  } else {
    const queue: UpdateQueue = [];
    transition = {
      kind: 'lowpri',
      queue,
      state: {kind: 'sync'},
      pendingCount: 0,
    };
  }
  activeTransition = transition;
  pendingLowPriTransition = transition;
  cb();
  queueLowPriTransition(transition);
  activeTransition = parentTransition;
}

function queueLowPriTransition(transition: LowPriTransition): void {
  console.log('queueLowPriTransition (microtask)');
  queuedTransition = transition;
  queueMicrotask(() => {
    if (queuedTransition !== transition) {
      return;
    }
    queuedTransition = null;
    runLowPriUpdate(transition);
    if (transition.state.kind === 'complete') {
      // all done!
      pendingLowPriTransition = null;
      return;
    } else if (transition.state.kind !== 'pending') {
      queueLowPriTransition(transition);
    }
  });
}
