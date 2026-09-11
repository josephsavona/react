/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {
  AnyComputeValue,
  AnyComputeUnit,
  AnyComputeStore,
  AnyAttributeListener,
  TextListener,
  AnyConditionalElementListener,
  AnyListElementListener,
  AnyBranch,
  AnyObserver,
  AnyValue,
  CompletedBranch,
  Effect,
  Flag,
  ListElementChild,
  ReactNode,
  AnyAwaitElement,
  SuspenseElement,
} from './FirTypes';

import {
  COMPUTE_STORE_TYPE,
  COMPUTE_UNIT_TYPE,
  TEXT_LISTENER_TYPE,
  ATTRIBUTE_LISTENER_TYPE,
  CONDITIONAL_ELEMENT_TYPE,
  LIST_ELEMENT_TYPE,
  CONTEXT_PROVIDER_TYPE,
  FLAG_PENDING_EFFECT_SELF,
  FLAG_PENDING_EFFECT_CHILD,
  FLAG_ALTERNATE_SYNC_SELF,
  FLAG_ALTERNATE_SYNC_CHILD,
  FLAG_ALTERNATE_VIEW_SELF,
  FLAG_ALTERNATE_VIEW_CHILD,
  FLAG_ALTERNATE_EFFECT_SELF,
  FLAG_ALTERNATE_EFFECT_CHILD,
  EFFECT_TYPE,
  FRAGMENT_TYPE,
  FLAG_PENDING_VIEW_CHILD,
  FLAG_PENDING_VIEW_SELF,
  FLAG_PENDING_SYNC_CHILD,
  FLAG_PENDING_SYNC_SELF,
  FLAG_INACTIVE,
  FLAG_CREATED_IN_ALTERNATE,
  SUSPENSE_ELEMENT_TYPE,
  AWAIT_ELEMENT_TYPE,
} from './FirTypes';
import {
  applyConditionalElementListenerMutations,
  applyConditionalElementListenerMutationsAlternate,
  runConditionalElementListener,
  runConditionalElementListenerAlternate,
  cleanupConditionListener,
} from './FirConditionalElement';
import {
  applyListElementListenerMutations,
  applyListElementListenerMutationsAlternate,
  cleanupListListener,
  runListElementListener,
  runListElementListenerAlternate,
} from './FirListElement';
import {
  cleanupAttributeListener,
  applyAttributeListenerMutations,
} from './FirAttributeListener';
import {cleanupEvent} from './FirEventListener';
import {runEffect, cleanupEffect} from './FirEffects';
import {
  applyTextListenerMutations,
  cleanupTextListener,
} from './FirTextListener';
import {
  runComputeStore,
  runComputeUnit,
  runComputeUnitAlternate,
  attachChild,
} from './FirRunners';
import {
  completeBranch,
  cleanupComputeUnit,
  createRootBranch,
  createAlternate,
} from './FirCreators';
import {setMode} from './FirMode';
import {printBranch} from './FirDebug';
import type {LowPriTransition, UpdateQueue} from './FirScheduler';
import {
  applyAwaitViewMutations,
  applyAwaitViewMutationsAlternate,
  applySuspenseViewMutations,
  applySuspenseViewMutationsAlternate,
  cleanupAwaitElement,
  cleanupSuspenseElement,
  runAwaitElement,
  runAwaitElementAlternate,
  runSuspenseElement,
  runSuspenseElementAlternate,
} from './FirAsync';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';

export const DEBUG: boolean = false && __DEV__;
export function log(msg: mixed): void {
  if (!DEBUG) {
    throw new Error('log() called in production build');
  }
  console.log(msg);
}

/************* WORKLOOP / UPDATES *****************/
let nextRootId: number = 0;
const ROOTS: Map<number, CompletedBranch> = new Map();

// This is the original version of flushing synchronously
// It doesn't support setState in render or waiting a microTask
// to see if promises resolve, so this is now decomposed into
// individual functions for phases with scheduling in FirScheduler
export function runQueueSync_DEPRECATED(queue: UpdateQueue): void {
  let hasChange = false;
  for (const {compute, value} of queue) {
    if (hasFlag(compute.state, FLAG_INACTIVE)) {
      // This is checked in enqueueUpdate with a warning, here we just skip
      // In case something unmounted between when it was called and when we
      // process the update
      continue;
    }
    const nextValue =
      typeof value === 'function' ? value(compute.$value) : value;
    if (nextValue === compute.$value) {
      continue;
    }
    hasChange = true;
    compute.$value = nextValue;
    queueObservers(compute.observers);
  }
  if (!hasChange) {
    return;
  }
  for (const root of ROOTS.values()) {
    if (DEBUG) {
      log('*** START ***');
      log('*** BEFORE SYNC ***');
      log(printBranch(root));
    }
    runBranchSynchronization(root);

    if (DEBUG) {
      log('*** BEFORE VIEW ***');
      log(printBranch(root));
    }
    runBranchViewMutations(root);

    if (DEBUG) {
      log('*** BEFORE EFFECTS ***');
      log(printBranch(root));
    }
    runBranchPassiveEffects(root);

    if (DEBUG) {
      log('*** AFTER EFFECTS ***');
      log(printBranch(root));
      log('*** FINISH ***');
    }
  }
}

/**
 * Runs the synchronization phase for the given queue of updates.
 * Returns true if any of the updates caused meaningful changes,
 * false if all the updates were no-ops.
 *
 * NOTE: returning true does not guarantee that there are view mutations
 * and/or effects that need to be processed, only that the queued updates
 * did actually change state relative to their previous values such that
 * there *may* be view mutations or effect updates to process.
 */
export function runSynchronizationPhase(queue: UpdateQueue): boolean {
  if (DEBUG) {
    log('*** runSynchronizationPhase() ***');
    log(queue);
  }
  let hasChange = false;
  for (const {compute, value} of queue) {
    if (hasFlag(compute.state, FLAG_INACTIVE)) {
      log('setState on unmounted component');
      continue;
    }
    const nextValue =
      typeof value === 'function' ? value(compute.$value) : value;
    if (nextValue === compute.$value) {
      continue;
    }
    hasChange = true;
    compute.$value = nextValue;
    queueObservers(compute.observers);
  }
  if (!hasChange) {
    return false;
  }
  for (const root of ROOTS.values()) {
    if (DEBUG) {
      log(printBranch(root));
    }
    runBranchSynchronization(root);
  }
  return true;
}

/**
 * Commits view mutations
 */
export function runCommitPhase(): void {
  if (DEBUG) {
    log('*** runCommitPhase() ***');
  }
  for (const root of ROOTS.values()) {
    if (DEBUG) {
      log(printBranch(root));
    }
    runBranchViewMutations(root);
  }
}

/**
 * Runs passive effects
 */
export function runPassiveEffects(): void {
  if (DEBUG) {
    log('*** runPassiveEffects() ***');
  }
  for (const root of ROOTS.values()) {
    if (DEBUG) {
      log(printBranch(root));
    }
    runBranchPassiveEffects(root);
  }
}

/**
 * This is the first pass implementation of an algorithm that could eventually be
 * made yieldy to support low-priority background rendering (startTransition).
 *
 * See separate functions below for a partially split up version of this.
 */
export function runQueueLowPri_DEPRECATED(queue: UpdateQueue): void {
  if (DEBUG) {
    log('runQueueLowPriority()');
  }
  setMode('alternate');
  let hasChange = false;
  for (const {compute, value} of queue) {
    if (hasFlag(compute.state, FLAG_INACTIVE)) {
      log('setState on unmounted component');
      continue;
    }
    const nextValue =
      typeof value === 'function' ? value(compute.$value) : value;
    let alternate = compute.alternate;
    if (alternate === null) {
      alternate = compute.alternate = createAlternate(compute);
    }
    if (nextValue === alternate.value) {
      continue;
    }
    hasChange = true;
    alternate.value = nextValue;
    queueObserversAlternate(compute.observers);
    queueViewMutationAlternate(compute, FLAG_ALTERNATE_VIEW_SELF);
  }
  if (!hasChange) {
    return;
  }
  for (const root of ROOTS.values()) {
    if (DEBUG) {
      log('*** START ***');
      log('*** BEFORE ALT-SYNC ***');
      log(printBranch(root));
    }
    runBranchAlternateSynchronization(root);

    if (DEBUG) {
      log('*** BEFORE ALT-COMMIT ***');
      log(printBranch(root));
    }
    runBranchCommitAlternateMutations(root);

    if (DEBUG) {
      log('*** BEFORE EFFECTS ***');
      log(printBranch(root));
    }
    runBranchAlternatePassiveEffects(root);

    if (DEBUG) {
      log('*** AFTER EFFECTS ***');
      log(printBranch(root));
      log('*** FINISH ***');
    }
  }
  setMode('sync');
}

// The transition state allows FirScheduler to drive the low-pri transition
// while only FirWorkloop knows the details of what will be performed next.
export type LowPriTransitionState =
  // Needs sync work
  | {kind: 'sync'}
  // No sync work, waiting for data
  | {kind: 'pending'}
  // Ready to commit
  | {kind: 'ready'}
  // Complete
  | {kind: 'complete'};

/**
 * Executes a low-priority update created with createLowPriUpdate() or
 * updated via this method. Depending on the state of the update this
 * will either make progress on synchronization or, if ready, commit
 * the update and run effects.
 *
 * Currently the algorithm is not very yieldy: synchronization still
 * happens synchronously, but it could be split up.
 */
export function runLowPriUpdate(transition: LowPriTransition): void {
  if (DEBUG) {
    log('runLowPriUpdate()');
  }
  if (transition.queue.length !== 0) {
    runLowPriQueue(transition.queue);
    transition.queue.length = 0;
    transition.state = {kind: 'sync'};
  }
  if (transition.state.kind === 'ready') {
    for (const root of ROOTS.values()) {
      if (DEBUG) {
        log('*** BEFORE ALT-COMMIT ***');
        log(printBranch(root));
      }
      runBranchCommitAlternateMutations(root);

      if (DEBUG) {
        log('*** BEFORE EFFECTS ***');
        log(printBranch(root));
      }
      runBranchAlternatePassiveEffects(root);

      if (DEBUG) {
        log('*** AFTER EFFECTS ***');
        log(printBranch(root));
        log('*** FINISH ***');
      }
    }
    transition.state = {kind: 'complete'};
  } else if (transition.state.kind === 'sync') {
    setMode('alternate');
    for (const root of ROOTS.values()) {
      if (DEBUG) {
        log('*** START ***');
        log('*** BEFORE ALT-SYNC ***');
        log(printBranch(root));
      }
      runBranchAlternateSynchronization(root);
    }
    setMode('sync');

    if (transition.pendingCount === 0) {
      transition.state = {kind: 'ready'};
    } else {
      transition.state = {kind: 'pending'};
    }
    if (DEBUG) {
      log('*** START ***');
      log('*** BEFORE ALT-SYNC ***');
      log(transition);
    }
    for (const root of ROOTS.values()) {
      if (DEBUG) {
        log(printBranch(root));
      }
      runBranchAlternateSynchronization(root);
    }
  } else if (transition.state.kind === 'pending') {
    throw new Error('runLowPriorityUpdate() executed for a pending transition');
  } else if (transition.state.kind === 'complete') {
    throw new Error(
      'runLowPriorityUpdate() executed for a completed transition',
    );
  } else {
    transition.state as empty;
    throw new Error('Unexpected transition state ' + transition.state.kind);
  }
}

function runLowPriQueue(queue: UpdateQueue): boolean {
  setMode('alternate');
  let hasChange = false;
  for (const {compute, value} of queue) {
    if (hasFlag(compute.state, FLAG_INACTIVE)) {
      log('setState on unmounted component');
      continue;
    }
    const nextValue =
      typeof value === 'function' ? value(compute.$value) : value;
    let alternate = compute.alternate;
    if (alternate === null) {
      alternate = compute.alternate = createAlternate(compute);
    }
    if (nextValue === alternate.value) {
      continue;
    }
    hasChange = true;
    alternate.value = nextValue;
    queueObserversAlternate(compute.observers);
    queueViewMutationAlternate(compute, FLAG_ALTERNATE_VIEW_SELF);
  }
  setMode('sync');
  return hasChange;
}

/**
 * Runs the synchronization phase for the given branch. Synchronization is responsible for
 * - Updating any invalidated computes and queuing listeners and effects
 * - Updating any listeners that affect branch structure:
 *   - context providers
 *   - conditional elements
 *   - list elements
 *
 * Notably this does *not* execute view mutations from the above, text/attribute listeners,
 * or effects. This phase only updates the branch structure, and stores a list of view
 * mutations to apply later to bring the DOM consistent with the branches.
 */
function runBranchSynchronization(branch: CompletedBranch) {
  if (hasFlag(branch.state, FLAG_PENDING_SYNC_SELF)) {
    for (let i = 0; i < branch.computes.length; i++) {
      const compute = branch.computes[i];
      if (hasFlag(compute.state, FLAG_PENDING_SYNC_SELF)) {
        switch (compute.$$type) {
          case COMPUTE_UNIT_TYPE: {
            const hasChange = runComputeUnit(compute);
            if (hasChange) {
              queueObservers(compute.observers);
            }
            compute.state = unsetFlag(compute.state, FLAG_PENDING_SYNC_SELF);
            break;
          }
          case COMPUTE_STORE_TYPE: {
            const hasChange = runComputeStore(compute);
            if (hasChange) {
              queueObservers(compute.observers);
            }
            compute.state = unsetFlag(compute.state, FLAG_PENDING_SYNC_SELF);
            break;
          }
          default: {
            compute as empty;
          }
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_PENDING_SYNC_SELF);
  }
  if (hasFlag(branch.state, FLAG_PENDING_SYNC_CHILD)) {
    for (let i = 0; i < branch.children.length; i++) {
      const child = branch.children[i];
      switch (child.$$type) {
        case CONDITIONAL_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_SYNC_SELF)) {
            runConditionalElementListener(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_SELF);
          }
          if (hasFlag(child.state, FLAG_PENDING_SYNC_CHILD)) {
            runBranchSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_CHILD);
          }
          break;
        }
        case LIST_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_SYNC_SELF)) {
            runListElementListener(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_SELF);
          }
          if (hasFlag(child.state, FLAG_PENDING_SYNC_CHILD)) {
            const children: Array<ListElementChild<AnyValue>> =
              child.children as $FlowFixMe;
            for (let i = 0; i < children.length; i++) {
              runBranchSynchronization(children[i].branch);
            }
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_CHILD);
          }
          break;
        }
        case CONTEXT_PROVIDER_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_SYNC_CHILD)) {
            runBranchSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_CHILD);
          }
          break;
        }
        case SUSPENSE_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_SYNC_SELF)) {
            runSuspenseElement(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_SELF);
          }
          if (
            hasFlag(child.state, FLAG_PENDING_SYNC_CHILD) &&
            child.status !== 'pending'
          ) {
            runBranchSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_CHILD);
          }
          break;
        }
        case AWAIT_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_SYNC_SELF)) {
            runAwaitElement(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_SELF);
          }
          if (
            hasFlag(child.state, FLAG_PENDING_SYNC_CHILD) &&
            child.status === 'resolved'
          ) {
            runBranchSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_SYNC_CHILD);
          }
          break;
        }
        default: {
          child as empty;
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_PENDING_SYNC_CHILD);
  }
}

/**
 * Low-priority variant of runBranchSynchronization. For now we don't implement any form
 * of sophisticated yield/resume. But note that this algorithm uses the same flagging system
 * as regular updates to know which parts of the tree need to be visited. We can exit at just
 * about any time (as long as flags are in a valid state) and "resume" simply by walking down
 * from the top again along the path that needs updates. It's likely we can do better than that,
 * but it's already not horrible.
 *
 * For now we focus on the mechanism itself. Which is surprisingly similar to the main synchronization
 * routine. The key differences are:
 * - Call alternate-aware version of runComputeUnit(), which will get-or-create an alternate and
 *   set the value there, queuing observers as necessary.
 * - Traverse using this method instead of regular runSync (duh)
 * - Use queueObserversAlternate() to use the alternate flags for marking changes.
 * - Use alternate versions of conditional and element listeners (TODO)
 *
 * Returns true if additional work is required within this branch.
 */
function runBranchAlternateSynchronization(branch: CompletedBranch): void {
  if (hasFlag(branch.state, FLAG_ALTERNATE_SYNC_SELF)) {
    for (let i = 0; i < branch.computes.length; i++) {
      const compute = branch.computes[i];
      if (hasFlag(compute.state, FLAG_ALTERNATE_SYNC_SELF)) {
        switch (compute.$$type) {
          case COMPUTE_UNIT_TYPE: {
            const hasChange = runComputeUnitAlternate(compute);
            if (hasChange) {
              // TODO: any compute (including values!) that gets an alternate
              // needs to be marked as needing commit phase merge back to canonical
              queueObserversAlternate(compute.observers);
              compute.state = unsetFlag(
                compute.state,
                FLAG_ALTERNATE_SYNC_SELF,
              );
              // We have to mark that this tree needs commit-time work to cleanup the alternate
              queueViewMutationAlternate(compute, FLAG_ALTERNATE_VIEW_SELF);
            }
            break;
          }
          case COMPUTE_STORE_TYPE: {
            // NOTE: I don't think we need runComputeStore generally. we already check
            // when setting the value if it has changed, and only mark as pending if it has.
            // so if we get here we already know the value changed and can just queue observers.
            queueObserversAlternate(compute.observers);
            compute.state = unsetFlag(compute.state, FLAG_ALTERNATE_SYNC_SELF);
            // We have to mark that this tree needs commit-time work to cleanup the alternate
            queueViewMutationAlternate(compute, FLAG_ALTERNATE_VIEW_SELF);
            break;
          }
          default: {
            compute as empty;
          }
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_ALTERNATE_SYNC_SELF);
  }

  if (hasFlag(branch.state, FLAG_ALTERNATE_SYNC_CHILD)) {
    for (let i = 0; i < branch.children.length; i++) {
      const child = branch.children[i];
      switch (child.$$type) {
        case CONDITIONAL_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_SELF)) {
            runConditionalElementListenerAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_SELF);
          }
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD)) {
            runBranchAlternateSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD);
          }
          break;
        }
        case LIST_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_SELF)) {
            runListElementListenerAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_SELF);
          }
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD)) {
            const children: Array<ListElementChild<AnyValue>> =
              child.children as $FlowFixMe;
            for (let i = 0; i < children.length; i++) {
              const item = children[i].branch;
              runBranchAlternateSynchronization(item);
            }
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD);
          }
          break;
        }
        case CONTEXT_PROVIDER_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD)) {
            runBranchAlternateSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD);
          }
          break;
        }
        case SUSPENSE_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_SELF)) {
            runSuspenseElementAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_SELF);
          }
          if (
            hasFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD) &&
            child.status !== 'pending'
          ) {
            runBranchAlternateSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD);
          }
          break;
        }
        case AWAIT_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_SYNC_SELF)) {
            runAwaitElementAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_SELF);
          }
          if (
            hasFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD) &&
            child.status === 'resolved'
          ) {
            runBranchAlternateSynchronization(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_SYNC_CHILD);
          }
          break;
        }
        default: {
          child as empty;
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_ALTERNATE_SYNC_CHILD);
  }
}

/**
 * Runs the view mutation phase. All computes will have already been processed,
 * so this phase visits any listeners with pending view mutations and applies them:
 * - conditional elements
 * - list elemenets
 * - text listener
 * - attribute listener
 */
function runBranchViewMutations(branch: CompletedBranch) {
  if (hasFlag(branch.state, FLAG_PENDING_VIEW_SELF)) {
    for (let i = 0; i < branch.views.length; i++) {
      const compute = branch.views[i];
      if (hasFlag(compute.state, FLAG_PENDING_VIEW_SELF)) {
        switch (compute.$$type) {
          case ATTRIBUTE_LISTENER_TYPE: {
            applyAttributeListenerMutations(compute);
            break;
          }
          case TEXT_LISTENER_TYPE: {
            applyTextListenerMutations(compute);
            break;
          }
          default: {
            compute as empty;
          }
        }
        compute.state = unsetFlag(compute.state, FLAG_PENDING_VIEW_SELF);
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_PENDING_VIEW_SELF);
  }
  if (hasFlag(branch.state, FLAG_PENDING_VIEW_CHILD)) {
    for (let i = 0; i < branch.children.length; i++) {
      const child = branch.children[i];
      switch (child.$$type) {
        case CONDITIONAL_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_VIEW_SELF)) {
            applyConditionalElementListenerMutations(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_SELF);
          }
          if (hasFlag(child.state, FLAG_PENDING_VIEW_CHILD)) {
            runBranchViewMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_CHILD);
          }
          break;
        }
        case LIST_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_VIEW_SELF)) {
            applyListElementListenerMutations(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_SELF);
          }
          if (hasFlag(child.state, FLAG_PENDING_VIEW_CHILD)) {
            const children: Array<ListElementChild<AnyValue>> =
              child.children as $FlowFixMe;
            for (let i = 0; i < children.length; i++) {
              runBranchViewMutations(children[i].branch);
            }
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_CHILD);
          }
          break;
        }
        case CONTEXT_PROVIDER_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_VIEW_CHILD)) {
            runBranchViewMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_CHILD);
          }
          break;
        }
        case SUSPENSE_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_VIEW_SELF)) {
            applySuspenseViewMutations(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_SELF);
          }
          if (
            hasFlag(child.state, FLAG_PENDING_VIEW_CHILD) &&
            child.status !== 'pending'
          ) {
            runBranchViewMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_CHILD);
          }
          break;
        }
        case AWAIT_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_VIEW_SELF)) {
            applyAwaitViewMutations(child);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_SELF);
          }
          if (
            hasFlag(child.state, FLAG_PENDING_VIEW_CHILD) &&
            child.status === 'resolved'
          ) {
            runBranchViewMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_VIEW_CHILD);
          }
          break;
        }
        default: {
          child as empty;
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_PENDING_VIEW_CHILD);
  }
}

/**
 * This is a combination of committing the alternates into the tree
 * and clearing them, in addition to performing view mutations.
 */
function runBranchCommitAlternateMutations(branch: CompletedBranch): void {
  if (hasFlag(branch.state, FLAG_ALTERNATE_VIEW_SELF)) {
    for (let i = 0; i < branch.values.length; i++) {
      const compute = branch.values[i];
      if (compute.alternate !== null) {
        compute.$value = compute.alternate.value;
        compute.alternate = null;
        compute.state = unsetFlag(compute.state, FLAG_ALTERNATE_VIEW_SELF);
      }
    }
    for (let i = 0; i < branch.computes.length; i++) {
      const compute = branch.computes[i];
      if (hasFlag(compute.state, FLAG_ALTERNATE_VIEW_SELF)) {
        switch (compute.$$type) {
          case COMPUTE_UNIT_TYPE: {
            // alternate must be set if the flag is set
            const alternate = compute.alternate as $FlowFixMe;
            compute.$value = alternate.value;
            compute.state = unsetFlag(compute.state, FLAG_ALTERNATE_VIEW_SELF);
            compute.alternate = null;
            break;
          }
          case COMPUTE_STORE_TYPE: {
            // alternate must be set if the flag is set
            const alternate = compute.alternate as $FlowFixMe;
            compute.$value = alternate.value;
            compute.state = unsetFlag(compute.state, FLAG_ALTERNATE_VIEW_SELF);
            compute.alternate = null;
            break;
          }
          default: {
            compute as empty;
          }
        }
      }
    }
    for (let i = 0; i < branch.views.length; i++) {
      const compute = branch.views[i];
      if (hasFlag(compute.state, FLAG_ALTERNATE_VIEW_SELF)) {
        switch (compute.$$type) {
          case ATTRIBUTE_LISTENER_TYPE: {
            // TODO: ideally we'd skip applying if the pending value ends up the same as
            // the canonical value
            applyAttributeListenerMutations(compute);
            break;
          }
          case TEXT_LISTENER_TYPE: {
            // TODO: ideally we'd skip applying if the pending value ends up the same as
            // the canonical value
            applyTextListenerMutations(compute);
            break;
          }
          default: {
            compute as empty;
          }
        }
        compute.state = unsetFlag(compute.state, FLAG_ALTERNATE_VIEW_SELF);
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_ALTERNATE_VIEW_SELF);
  }
  if (hasFlag(branch.state, FLAG_ALTERNATE_VIEW_CHILD)) {
    for (let i = 0; i < branch.children.length; i++) {
      const child = branch.children[i];
      switch (child.$$type) {
        case CONDITIONAL_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_SELF)) {
            applyConditionalElementListenerMutationsAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_SELF);
          }
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD)) {
            runBranchCommitAlternateMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD);
          }
          break;
        }
        case LIST_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_SELF)) {
            applyListElementListenerMutationsAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_SELF);
          }
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD)) {
            const children: Array<ListElementChild<AnyValue>> =
              child.children as $FlowFixMe;
            for (let i = 0; i < children.length; i++) {
              runBranchCommitAlternateMutations(children[i].branch);
            }
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD);
          }
          break;
        }
        case CONTEXT_PROVIDER_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD)) {
            runBranchCommitAlternateMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD);
          }
          break;
        }
        case SUSPENSE_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_SELF)) {
            applySuspenseViewMutationsAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_SELF);
          }
          if (
            hasFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD) &&
            child.status !== 'pending'
          ) {
            runBranchCommitAlternateMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD);
          }
          break;
        }
        case AWAIT_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_VIEW_SELF)) {
            applyAwaitViewMutationsAlternate(child);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_SELF);
          }
          if (
            hasFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD) &&
            child.status === 'resolved'
          ) {
            runBranchCommitAlternateMutations(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_VIEW_CHILD);
          }
          break;
        }
        default: {
          child as empty;
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_ALTERNATE_VIEW_CHILD);
  }
}

/**
 * Runs passive effects for the branch, executing effects in children before parents.
 */
function runBranchPassiveEffects(branch: CompletedBranch) {
  // Run child effects before parents
  if (hasFlag(branch.state, FLAG_PENDING_EFFECT_CHILD)) {
    for (let i = 0; i < branch.children.length; i++) {
      const child = branch.children[i];
      switch (child.$$type) {
        case CONDITIONAL_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_EFFECT_CHILD)) {
            runBranchPassiveEffects(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_EFFECT_CHILD);
          }
          break;
        }
        case LIST_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_EFFECT_CHILD)) {
            const children: Array<ListElementChild<AnyValue>> =
              child.children as $FlowFixMe;
            for (let i = 0; i < children.length; i++) {
              runBranchPassiveEffects(children[i].branch);
            }
            child.state = unsetFlag(child.state, FLAG_PENDING_EFFECT_CHILD);
          }
          break;
        }
        case CONTEXT_PROVIDER_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_EFFECT_CHILD)) {
            runBranchPassiveEffects(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_EFFECT_CHILD);
          }
          break;
        }
        case SUSPENSE_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_PENDING_EFFECT_CHILD)) {
            if (child.status === 'pending') {
              runBranchPassiveEffects(child.fallbackChild as $FlowFixMe);
            } else {
              runBranchPassiveEffects(child.child as $FlowFixMe);
            }
            child.state = unsetFlag(child.state, FLAG_PENDING_EFFECT_CHILD);
          }
          break;
        }
        case AWAIT_ELEMENT_TYPE: {
          if (
            hasFlag(child.state, FLAG_PENDING_EFFECT_CHILD) &&
            child.status === 'resolved'
          ) {
            runBranchPassiveEffects(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_PENDING_EFFECT_CHILD);
          }
          break;
        }
        default: {
          child as empty;
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_PENDING_EFFECT_CHILD);
  }
  if (hasFlag(branch.state, FLAG_PENDING_EFFECT_SELF)) {
    for (let i = 0; i < branch.effects.length; i++) {
      const effect = branch.effects[i];
      if (hasFlag(effect.state, FLAG_PENDING_EFFECT_SELF)) {
        runEffect(effect);
        effect.state = unsetFlag(effect.state, FLAG_PENDING_EFFECT_SELF);
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_PENDING_EFFECT_SELF);
  }
}

/**
 * Alternate/low-pri version of committing passive effects. Exactly the same so far,
 * just checks different flags.
 */
function runBranchAlternatePassiveEffects(branch: CompletedBranch): void {
  // Run child effects before parents
  if (hasFlag(branch.state, FLAG_ALTERNATE_EFFECT_CHILD)) {
    for (let i = 0; i < branch.children.length; i++) {
      const child = branch.children[i];
      switch (child.$$type) {
        case CONDITIONAL_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD)) {
            runBranchAlternatePassiveEffects(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD);
          }
          break;
        }
        case LIST_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD)) {
            const children: Array<ListElementChild<AnyValue>> =
              child.children as $FlowFixMe;
            for (let i = 0; i < children.length; i++) {
              runBranchAlternatePassiveEffects(children[i].branch);
            }
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD);
          }
          break;
        }
        case CONTEXT_PROVIDER_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD)) {
            runBranchAlternatePassiveEffects(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD);
          }
          break;
        }
        case SUSPENSE_ELEMENT_TYPE: {
          if (hasFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD)) {
            if (child.status === 'pending') {
              runBranchAlternatePassiveEffects(
                child.fallbackChild as $FlowFixMe,
              );
            } else {
              runBranchAlternatePassiveEffects(child.child as $FlowFixMe);
            }
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD);
          }
          break;
        }
        case AWAIT_ELEMENT_TYPE: {
          if (
            hasFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD) &&
            child.status === 'resolved'
          ) {
            runBranchAlternatePassiveEffects(child.child as $FlowFixMe);
            child.state = unsetFlag(child.state, FLAG_ALTERNATE_EFFECT_CHILD);
          }
          break;
        }
        default: {
          child as empty;
        }
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_ALTERNATE_EFFECT_CHILD);
  }
  if (hasFlag(branch.state, FLAG_ALTERNATE_EFFECT_SELF)) {
    for (let i = 0; i < branch.effects.length; i++) {
      const effect = branch.effects[i];
      if (hasFlag(effect.state, FLAG_ALTERNATE_EFFECT_SELF)) {
        runEffect(effect);
        effect.state = unsetFlag(effect.state, FLAG_ALTERNATE_EFFECT_SELF);
      }
    }
    branch.state = unsetFlag(branch.state, FLAG_ALTERNATE_EFFECT_SELF);
  }
}

/**
 * When a branch is created in a low-priority render, *all* of its compute nodes
 * will be marked as FLAG_CREATED_IN_ALTERNATE. This is necessary so that any
 * updates to sources of these nodes know how to mark the nodes - as needing follow-up
 * in the alternate sync, not the high-pri sync.
 *
 * When we commit the branch we have to flip these flags.
 *
 * TODO: can we avoid this? feels like it should be possible.
 */
export function markAlternateBranchAsAttached(branch: CompletedBranch): void {
  if (DEBUG) {
    if (!hasFlag(branch.state, FLAG_CREATED_IN_ALTERNATE)) {
      throw new Error(
        'Expected to be called only for new branches created in low-pri renders',
      );
    }
  }
  for (let i = 0; i < branch.values.length; i++) {
    const compute = branch.values[i];
    if (hasFlag(compute.state, FLAG_CREATED_IN_ALTERNATE)) {
      compute.state = unsetFlag(compute.state, FLAG_CREATED_IN_ALTERNATE);
    }
  }
  for (let i = 0; i < branch.computes.length; i++) {
    const compute = branch.computes[i];
    if (hasFlag(compute.state, FLAG_CREATED_IN_ALTERNATE)) {
      compute.state = unsetFlag(compute.state, FLAG_CREATED_IN_ALTERNATE);
    }
  }
  for (let i = 0; i < branch.views.length; i++) {
    const compute = branch.views[i];
    if (hasFlag(compute.state, FLAG_CREATED_IN_ALTERNATE)) {
      compute.state = unsetFlag(compute.state, FLAG_CREATED_IN_ALTERNATE);
    }
  }
  for (let i = 0; i < branch.children.length; i++) {
    const child = branch.children[i];
    switch (child.$$type) {
      case CONDITIONAL_ELEMENT_TYPE: {
        if (hasFlag(child.state, FLAG_CREATED_IN_ALTERNATE)) {
          markAlternateBranchAsAttached(child.child as $FlowFixMe);
          child.state = unsetFlag(child.state, FLAG_CREATED_IN_ALTERNATE);
        }
        break;
      }
      case LIST_ELEMENT_TYPE: {
        if (hasFlag(child.state, FLAG_CREATED_IN_ALTERNATE)) {
          const children: Array<ListElementChild<AnyValue>> =
            child.children as $FlowFixMe;
          for (let i = 0; i < children.length; i++) {
            markAlternateBranchAsAttached(children[i].branch);
          }
          child.state = unsetFlag(child.state, FLAG_CREATED_IN_ALTERNATE);
        }
        break;
      }
      case CONTEXT_PROVIDER_TYPE: {
        if (hasFlag(child.state, FLAG_CREATED_IN_ALTERNATE)) {
          markAlternateBranchAsAttached(child.child as $FlowFixMe);
          child.state = unsetFlag(child.state, FLAG_CREATED_IN_ALTERNATE);
        }
        break;
      }
      case SUSPENSE_ELEMENT_TYPE:
      case AWAIT_ELEMENT_TYPE: {
        throw new Error('[todo] low-pri support for suspense/await');
      }
      default: {
        child as empty;
      }
    }
  }
  for (let i = 0; i < branch.effects.length; i++) {
    const effect = branch.effects[i];
    if (hasFlag(effect.state, FLAG_CREATED_IN_ALTERNATE)) {
      effect.state = unsetFlag(effect.state, FLAG_CREATED_IN_ALTERNATE);
    }
  }
  branch.state = unsetFlag(branch.state, FLAG_CREATED_IN_ALTERNATE);
}

export function unmountBranchAndRemoveNodes(branch: CompletedBranch): void {
  unlinkBranch(branch);
  removeBranchNodes(branch);
}

export function removeBranchNodes(branch: CompletedBranch): void {
  const node: ReactNode = branch.node as $FlowFixMe;
  detachNode(node);
}

export function detachNode(node: ReactNode): void {
  if (node instanceof Node) {
    if (node.parentNode != null) {
      node.parentNode.removeChild(node);
    }
  } else if (node.$$type === CONDITIONAL_ELEMENT_TYPE) {
    detachConditionalElement(node);
  } else if (node.$$type === LIST_ELEMENT_TYPE) {
    detachListElement(node);
  } else if (node.$$type === CONTEXT_PROVIDER_TYPE) {
    removeBranchNodes(node.child as $FlowFixMe);
  } else if (node.$$type === FRAGMENT_TYPE) {
    for (let i = 0; i < node.children.length; i++) {
      detachNode(node.children[i]);
    }
  } else if (node.$$type === SUSPENSE_ELEMENT_TYPE) {
    detachSuspenseElement(node);
  } else if (node.$$type === AWAIT_ELEMENT_TYPE) {
    detachAwaitElement(node);
  } else {
    node as empty;
    throw new Error('unexpected node type');
  }
}

function detachConditionalElement(
  listener: AnyConditionalElementListener,
): void {
  removeBranchNodes(listener.child as $FlowFixMe);
  const parentNode = listener.anchor.parentNode;
  if (parentNode != null) {
    parentNode.removeChild(listener.anchor);
  }
}

function detachListElement(listener: AnyListElementListener): void {
  if (Array.isArray(listener.children)) {
    for (let i = 0; i < listener.children.length; i++) {
      removeBranchNodes(listener.children[i].branch);
    }
  }
  const parentNode = listener.anchor.parentNode;
  if (parentNode != null) {
    parentNode.removeChild(listener.anchor);
  }
}

function detachSuspenseElement(listener: SuspenseElement): void {
  if (listener.child != null) {
    removeBranchNodes(listener.child as $FlowFixMe);
  }
  if (listener.fallbackChild != null) {
    removeBranchNodes(listener.fallbackChild as $FlowFixMe);
  }
  const parentNode = listener.anchor.parentNode;
  if (parentNode != null) {
    parentNode.removeChild(listener.anchor);
  }
}

function detachAwaitElement(listener: AnyAwaitElement): void {
  if (listener.child != null) {
    removeBranchNodes(listener.child as $FlowFixMe);
  }
  const parentNode = listener.anchor.parentNode;
  if (parentNode != null) {
    parentNode.removeChild(listener.anchor);
  }
}

/**
 * Unlinks the compute graph contained within the given branch. This ensures that all observers
 * within the branch are removed from any sources that are defined outside of the branch.
 *
 * As an optimization, as we walk down the branch we mark compute sources owned within the branch
 * as inactive. Then, when removing observers from their sources, we can bail out if the source
 * is already inactive. This allows us to only pay the cost of removing observers from source arrays
 * for those (likely few) places where something in the branch observes something outside the branch.
 */
export function unlinkBranch(branch: CompletedBranch): void {
  for (let i = 0; i < branch.values.length; i++) {
    const value = branch.values[i];
    value.state = setFlag(value.state, FLAG_INACTIVE);
  }
  for (let i = 0; i < branch.computes.length; i++) {
    const compute = branch.computes[i];
    switch (compute.$$type) {
      case COMPUTE_UNIT_TYPE: {
        cleanupComputeUnit(compute);
        compute.state = setFlag(compute.state, FLAG_INACTIVE);
        break;
      }
      case COMPUTE_STORE_TYPE: {
        compute.state = setFlag(compute.state, FLAG_INACTIVE);
        break;
      }
      default: {
        compute as empty;
      }
    }
  }
  for (let i = 0; i < branch.views.length; i++) {
    const compute = branch.views[i];
    switch (compute.$$type) {
      case TEXT_LISTENER_TYPE: {
        cleanupTextListener(compute);
        break;
      }
      case ATTRIBUTE_LISTENER_TYPE: {
        cleanupAttributeListener(compute);
        break;
      }
      default: {
        compute as empty;
      }
    }
  }
  for (let i = 0; i < branch.children.length; i++) {
    const child = branch.children[i];
    switch (child.$$type) {
      case CONDITIONAL_ELEMENT_TYPE: {
        cleanupConditionListener(child);
        break;
      }
      case LIST_ELEMENT_TYPE: {
        cleanupListListener(child);
        break;
      }
      case CONTEXT_PROVIDER_TYPE: {
        unlinkBranch(child.child as $FlowFixMe);
        break;
      }
      case SUSPENSE_ELEMENT_TYPE: {
        cleanupSuspenseElement(child);
        break;
      }
      case AWAIT_ELEMENT_TYPE: {
        cleanupAwaitElement(child);
        break;
      }
      default: {
        child as empty;
      }
    }
  }
  for (let i = 0; i < branch.effects.length; i++) {
    const effect = branch.effects[i];
    cleanupEffect(effect);
  }
  for (let i = 0; i < branch.events.length; i++) {
    const event = branch.events[i];
    cleanupEvent(event);
  }
}

export function queueObservers(observers: Array<AnyObserver>): void {
  for (let i = 0; i < observers.length; i++) {
    const observer = observers[i];
    if (hasFlag(observer.state, FLAG_CREATED_IN_ALTERNATE)) {
      queueObserverAlternate(observer);
      continue;
    }
    queueObserver(observer);
  }
}

function queueObserver(observer: AnyObserver): void {
  switch (observer.$$type) {
    case EFFECT_TYPE: {
      queueEffect(observer);
      break;
    }
    case TEXT_LISTENER_TYPE:
    case ATTRIBUTE_LISTENER_TYPE: {
      queueViewMutation(observer, FLAG_PENDING_VIEW_SELF);
      break;
    }
    case SUSPENSE_ELEMENT_TYPE:
    case AWAIT_ELEMENT_TYPE:
    case CONDITIONAL_ELEMENT_TYPE:
    case LIST_ELEMENT_TYPE: {
      queueObserverSync(
        observer,
        FLAG_PENDING_SYNC_SELF,
        FLAG_PENDING_SYNC_CHILD,
      );
      break;
    }
    case COMPUTE_STORE_TYPE: {
      queueObserverSync(
        observer,
        FLAG_PENDING_SYNC_SELF,
        FLAG_PENDING_SYNC_SELF,
      );
      break;
    }
    case COMPUTE_UNIT_TYPE: {
      if (observer.$value === UNINITIALIZED_COMPUTE_VALUE) {
        break;
      }
      queueObserverSync(
        observer,
        FLAG_PENDING_SYNC_SELF,
        FLAG_PENDING_SYNC_SELF,
      );
      break;
    }
    case CONTEXT_PROVIDER_TYPE: {
      throw new Error(
        'todo: context provider cant be an observer, fix this in the types',
      );
    }
    default: {
      observer as empty;
    }
  }
}

export function queueEffect(effect: Effect): void {
  effect.state = setFlag(effect.state, FLAG_PENDING_EFFECT_SELF);
  effect.parent.state = setFlag(effect.parent.state, FLAG_PENDING_EFFECT_SELF);
  let parent = effect.parent.parent;
  while (parent !== null) {
    if (hasFlag(parent.state, FLAG_PENDING_EFFECT_CHILD)) {
      break;
    }
    parent.state = setFlag(parent.state, FLAG_PENDING_EFFECT_CHILD);
    parent = parent.parent;
  }
}

export function queueViewMutation(
  listener:
    | AnyConditionalElementListener
    | AnyListElementListener
    | TextListener
    | AnyAttributeListener
    | SuspenseElement
    | AnyAwaitElement,
  parentFlag: Flag,
): void {
  listener.state = setFlag(listener.state, FLAG_PENDING_VIEW_SELF);
  listener.parent.state = setFlag(listener.parent.state, parentFlag);
  let parent = listener.parent.parent;
  while (parent !== null) {
    if (hasFlag(parent.state, FLAG_PENDING_VIEW_CHILD)) {
      break;
    }
    parent.state = setFlag(parent.state, FLAG_PENDING_VIEW_CHILD);
    parent = parent.parent;
  }
}

function queueObserverSync(
  observer: AnyObserver,
  selfFlag: Flag,
  parentFlag: Flag,
): void {
  observer.state = setFlag(observer.state, selfFlag);
  observer.parent.state = setFlag(observer.parent.state, parentFlag);
  let parent = observer.parent.parent;
  while (parent !== null) {
    if (hasFlag(parent.state, FLAG_PENDING_SYNC_CHILD)) {
      break;
    }
    parent.state = setFlag(parent.state, FLAG_PENDING_SYNC_CHILD);
    parent = parent.parent;
  }
}

export function queueObserversAlternate(observers: Array<AnyObserver>): void {
  for (let i = 0; i < observers.length; i++) {
    const observer = observers[i];
    queueObserverAlternate(observer);
  }
}

function queueObserverAlternate(observer: AnyObserver): void {
  switch (observer.$$type) {
    case EFFECT_TYPE: {
      queueEffectAlternate(observer);
      break;
    }
    case TEXT_LISTENER_TYPE:
    case ATTRIBUTE_LISTENER_TYPE: {
      queueViewMutationAlternate(observer, FLAG_ALTERNATE_VIEW_SELF);
      break;
    }
    case SUSPENSE_ELEMENT_TYPE:
    case AWAIT_ELEMENT_TYPE:
    case CONDITIONAL_ELEMENT_TYPE:
    case LIST_ELEMENT_TYPE: {
      queueObserverSyncAlternate(
        observer,
        FLAG_ALTERNATE_SYNC_SELF,
        FLAG_ALTERNATE_SYNC_CHILD,
      );
      break;
    }
    case COMPUTE_STORE_TYPE: {
      queueObserverSyncAlternate(
        observer,
        FLAG_ALTERNATE_SYNC_SELF,
        FLAG_ALTERNATE_SYNC_SELF,
      );
      break;
    }
    case COMPUTE_UNIT_TYPE: {
      if (observer.$value === UNINITIALIZED_COMPUTE_VALUE) {
        break;
      }
      queueObserverSyncAlternate(
        observer,
        FLAG_ALTERNATE_SYNC_SELF,
        FLAG_ALTERNATE_SYNC_SELF,
      );
      break;
    }
    case CONTEXT_PROVIDER_TYPE: {
      throw new Error(
        'todo: context provider cant be an observer, fix this in the types',
      );
    }
    default: {
      observer as empty;
    }
  }
}

export function queueEffectAlternate(effect: Effect): void {
  effect.state = setFlag(effect.state, FLAG_ALTERNATE_EFFECT_SELF);
  effect.parent.state = setFlag(
    effect.parent.state,
    FLAG_ALTERNATE_EFFECT_SELF,
  );
  let parent = effect.parent.parent;
  while (parent !== null) {
    if (hasFlag(parent.state, FLAG_ALTERNATE_EFFECT_CHILD)) {
      break;
    }
    parent.state = setFlag(parent.state, FLAG_ALTERNATE_EFFECT_CHILD);
    parent = parent.parent;
  }
}

export function queueViewMutationAlternate(
  listener:
    | AnyComputeValue
    | AnyComputeUnit
    | AnyComputeStore
    | AnyConditionalElementListener
    | AnyListElementListener
    | TextListener
    | AnyAttributeListener
    | SuspenseElement
    | AnyAwaitElement,
  parentFlag: Flag,
): void {
  listener.state = setFlag(listener.state, FLAG_ALTERNATE_VIEW_SELF);
  listener.parent.state = setFlag(listener.parent.state, parentFlag);
  let parent = listener.parent.parent;
  while (parent !== null) {
    if (hasFlag(parent.state, FLAG_ALTERNATE_VIEW_CHILD)) {
      break;
    }
    parent.state = setFlag(parent.state, FLAG_ALTERNATE_VIEW_CHILD);
    parent = parent.parent;
  }
}

function queueObserverSyncAlternate(
  observer: AnyObserver,
  selfFlag: Flag,
  parentFlag: Flag,
): void {
  observer.state = setFlag(observer.state, selfFlag);
  observer.parent.state = setFlag(observer.parent.state, parentFlag);
  let parent = observer.parent.parent;
  while (parent !== null) {
    if (hasFlag(parent.state, FLAG_ALTERNATE_SYNC_CHILD)) {
      break;
    }
    parent.state = setFlag(parent.state, FLAG_ALTERNATE_SYNC_CHILD);
    parent = parent.parent;
  }
}

export function setFlag(state: Flag, flag: Flag): Flag {
  return state | flag;
}
export function unsetFlag(state: Flag, flag: Flag): Flag {
  return state & ~flag;
}
export function hasFlag(state: Flag, flag: Flag): boolean {
  return (state & flag) !== 0;
}

export function render<T>(
  parentNode: Node,
  component: (branch: AnyBranch, props: T) => ReactNode,
  props: T,
): () => void {
  const branch = createRootBranch<void>();
  const node = component(branch, props);
  attachChild(parentNode, node);
  const completed = completeBranch(branch, node);
  runBranchPassiveEffects(completed);
  const id = nextRootId++;
  ROOTS.set(id, completed);
  return () => {
    ROOTS.delete(id);
    unmountBranchAndRemoveNodes(completed);
  };
}
