/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {
  AnyBranch,
  AnyValue,
  AwaitElement,
  BranchParent,
  Compute,
  ReactNode,
  ReactiveCompute,
  SuspenseElement,
} from './FirTypes';

import {
  addObserver,
  completeBranch,
  createBranch,
  createComputeValue,
  readReactive,
  removeObserver,
} from './FirCreators';
import {isAlternate} from './FirMode';
import {
  AWAIT_ELEMENT_TYPE,
  CONDITIONAL_ELEMENT_TYPE,
  CONTEXT_PROVIDER_TYPE,
  DEFAULT_BRANCH_STATE,
  FLAG_CREATED_IN_ALTERNATE,
  FLAG_INACTIVE,
  FLAG_PENDING_VIEW_CHILD,
  FRAGMENT_TYPE,
  LIST_ELEMENT_TYPE,
  SUSPENSE_ELEMENT_TYPE,
} from './FirTypes';
import {attachChildBefore, initializeCompute} from './FirRunners';
import {
  hasFlag,
  queueViewMutation,
  queueViewMutationAlternate,
  unlinkBranch,
} from './FirWorkloop';
import {
  enqueueUpdate,
  queuePendingPromise,
  resolvePendingPromise,
} from './FirScheduler';
import {FLAG_ALTERNATE_VIEW_CHILD} from './Fir';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';

export function createSuspense(
  parent: AnyBranch,
  fallback: (branch: AnyBranch) => ReactNode,
  renderFunction: (branch: AnyBranch) => ReactNode,
): SuspenseElement {
  const $: SuspenseElement = {
    $$type: SUSPENSE_ELEMENT_TYPE,
    parent,
    // $FlowFixMe[extra-arg]
    anchor: new Comment(''),
    fallback,
    pending: createComputeValue(parent, 0),
    renderFunction,
    fallbackChild: null,
    child: null,
    status: 'init',
    alternate: null,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_BRANCH_STATE,
  };
  parent.children.push($);
  addObserver($, $.pending);
  return $;
}

export function cleanupSuspenseElement(listener: SuspenseElement): void {
  if (listener.fallbackChild !== null) {
    unlinkBranch(listener.fallbackChild.branch);
  }
  if (listener.child !== null) {
    unlinkBranch(listener.child);
  }
}

export function createAwait<T>(
  parent: AnyBranch,
  source: ReactiveCompute<Promise<T>>,
  renderFunction: (branch: AnyBranch, value: Compute<T>) => ReactNode,
): AwaitElement<T> {
  const $: AwaitElement<T> = {
    $$type: AWAIT_ELEMENT_TYPE,
    parent,
    // $FlowFixMe[extra-arg]
    anchor: new Comment(''),
    source,
    promise: null,
    value: createComputeValue(parent, UNINITIALIZED_COMPUTE_VALUE),
    renderFunction,
    child: null,
    status: 'init',
    alternate: null,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_BRANCH_STATE,
  };
  parent.children.push($);
  initializeCompute(source);
  addObserver($, source);
  addObserver($, $.value);
  return $;
}

export function cleanupAwaitElement<T>(listener: AwaitElement<T>): void {
  removeObserver(listener, listener.source);
  // TODO: probably not necessary to remove since they're created and destroyed together
  removeObserver(listener, listener.value);
  if (listener.child !== null) {
    unlinkBranch(listener.child as $FlowFixMe);
  }
}

export function runSuspenseElement(listener: SuspenseElement): void {
  const anchor = listener.anchor;
  const parentNode = anchor.parentNode as $FlowFixMe as Node;
  const pending = readReactive(listener.pending);

  if (listener.child === null) {
    // First render. We try rendering the main branch. This may suspend
    // and end up queueing an update to flip this listener to pending state,
    // but we'll always be able to construct the branch.
    const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
    const node = listener.renderFunction(nextBranch);
    const completed = completeBranch(nextBranch, node);
    listener.child = completed;
    attachChildBefore(parentNode, node, anchor);
  } else if (pending !== 0) {
    // We must switch to showing the fallback
    // First initialize the fallback if we haven't already
    if (listener.fallbackChild === null) {
      const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
      const node = listener.fallback(nextBranch);
      const completed = completeBranch(nextBranch, node);
      listener.fallbackChild = {
        branch: completed,
        mounted: false,
      };
    }
    if (listener.status !== 'pending') {
      // The view mutation phase will hide the content, show the fallback
      queueViewMutation(listener, FLAG_PENDING_VIEW_CHILD);
      listener.status = 'pending';
    }
  } else {
    // We must switch to showing the child
    if (listener.status !== 'resolved') {
      // The view mutation phase will hide the fallback, show the content
      queueViewMutation(listener, FLAG_PENDING_VIEW_CHILD);
      listener.status = 'resolved';
    }
  }
}

export function runSuspenseElementAlternate(listener: SuspenseElement): void {
  if (__DEV__) {
    if (listener.child === null) {
      throw new Error(
        'Oops, expected runSuspenseElementAlternate to only run for updates',
      );
    }
  }

  const pending = readReactive(listener.pending);
  if (pending !== 0) {
    if (listener.fallbackChild == null) {
      const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
      const node = listener.fallback(nextBranch);
      const completed = completeBranch(nextBranch, node);
      listener.fallbackChild = {
        branch: completed,
        mounted: false,
      };
    }
    if (listener.alternate == null || listener.alternate.status !== 'pending') {
      // The view mutation phase will hide the content, show the fallback
      queueViewMutationAlternate(listener, FLAG_PENDING_VIEW_CHILD);
      listener.alternate = {status: 'pending'};
    }
  } else {
    if (
      listener.alternate == null ||
      listener.alternate.status !== 'resolved'
    ) {
      queueViewMutationAlternate(listener, FLAG_PENDING_VIEW_CHILD);
      listener.alternate = {status: 'resolved'};
    }
  }
}

export function applySuspenseViewMutations(listener: SuspenseElement): void {
  const fallbackDisplay = listener.status === 'pending' ? null : 'none';
  const fallbackChild = listener.fallbackChild;
  if (fallbackChild != null) {
    if (!fallbackChild.mounted && listener.status === 'pending') {
      const parentNode = listener.anchor.parentNode as $FlowFixMe;
      attachChildBefore(
        parentNode,
        fallbackChild.branch.node as $FlowFixMe,
        listener.anchor,
      );
      fallbackChild.mounted = true;
    }
    setDisplay(fallbackChild.branch.node as $FlowFixMe, fallbackDisplay);
  }
  const childDisplay = listener.status === 'resolved' ? null : 'none';
  const child = listener.child;
  if (child !== null) {
    setDisplay(child.node as $FlowFixMe, childDisplay);
  }
}

export function applySuspenseViewMutationsAlternate(
  listener: SuspenseElement,
): void {
  const alternate = listener.alternate;
  if (alternate == null) {
    console.warn(`applySuspenseViewMutationsAlternate(): no alternate`);
    return;
  }
  const fallbackDisplay = alternate.status === 'pending' ? null : 'none';
  const fallbackChild = listener.fallbackChild;
  if (fallbackChild != null) {
    if (!fallbackChild.mounted && alternate.status === 'pending') {
      const parentNode = listener.anchor.parentNode as $FlowFixMe;
      attachChildBefore(
        parentNode,
        fallbackChild.branch.node as $FlowFixMe,
        listener.anchor,
      );
      fallbackChild.mounted = true;
    }
    setDisplay(fallbackChild.branch.node as $FlowFixMe, fallbackDisplay);
  }
  const childDisplay = alternate.status === 'resolved' ? null : 'none';
  const child = listener.child;
  if (child !== null) {
    setDisplay(child.node as $FlowFixMe, childDisplay);
  }
  listener.status = alternate.status;
  listener.alternate = null;
}

function setDisplay(child: ReactNode, display: null | 'none'): void {
  if (child instanceof Node) {
    if (display == null) {
      (child as $FlowFixMe).style.display = '';
    } else {
      (child as $FlowFixMe).style.display = display;
    }
  } else if (child.$$type === AWAIT_ELEMENT_TYPE) {
    if (child.child !== null) {
      setDisplay(child.child.branch.node as $FlowFixMe, display);
    }
  } else if (child.$$type === CONDITIONAL_ELEMENT_TYPE) {
    if (child.child != null) {
      setDisplay(child.child.node as $FlowFixMe, display);
    }
  } else if (child.$$type === LIST_ELEMENT_TYPE) {
    if (child.children != null) {
      for (let i = 0; i < child.children.length; i++) {
        setDisplay(child.children[i].branch.node as $FlowFixMe, display);
      }
    }
  } else if (child.$$type === CONTEXT_PROVIDER_TYPE) {
    setDisplay((child.child as $FlowFixMe).node as $FlowFixMe, display);
  } else if (child.$$type === SUSPENSE_ELEMENT_TYPE) {
    setDisplay((child.child as $FlowFixMe).node as $FlowFixMe, display);
  } else if (child.$$type === FRAGMENT_TYPE) {
    for (let i = 0; i < child.children.length; i++) {
      setDisplay(child.children[i], display);
    }
  } else {
    child as empty;
    throw new Error('todo: setDisplay for other ReactNode types');
  }
}

/**
 * Called either on initial render or when the promise itself changes,
 * *not* when the promise resolves.
 */
export function runAwaitElement<T>(listener: AwaitElement<T>): void {
  const promise = readReactive(listener.source);
  if (listener.status === 'init') {
    suspend(listener, promise);
    listener.status = 'pending';
  } else if (promise !== listener.promise) {
    // Whenever the promise changes it doesn't matter what was previously
    // resolved, we're in a pending state now
    suspend(listener, promise);
    if (listener.status !== 'pending') {
      queueViewMutation(listener, FLAG_PENDING_VIEW_CHILD);
      listener.status = 'pending';
    }
  } else {
    // If the promise didn't change then the value did, which means
    // it resolved
    if (listener.child === null) {
      const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
      const node = listener.renderFunction(
        nextBranch,
        listener.value as $FlowFixMe,
      );
      const completed = completeBranch(nextBranch, node);
      listener.child = {branch: completed, mounted: false};
    }
    if (listener.status !== 'resolved') {
      queueViewMutation(listener, FLAG_PENDING_VIEW_CHILD);
      listener.status = 'resolved';
    }
  }
  listener.promise = promise;
}

export function runAwaitElementAlternate<T>(listener: AwaitElement<T>): void {
  const promise = readReactive(listener.source);
  let alternate = listener.alternate;
  if (alternate == null || alternate.status === 'init') {
    suspend(listener, promise);
    alternate = listener.alternate = {
      status: 'pending',
      child: null,
      promise,
    };
  } else if (promise !== alternate.promise) {
    // TODO: stop waiting on the old promise (for the low-pri transition)
    suspend(listener, promise);
    if (alternate.status !== 'pending') {
      queueViewMutationAlternate(listener, FLAG_ALTERNATE_VIEW_CHILD);
      alternate.status = 'pending';
    }
  } else {
    if (listener.child === null && alternate.child === null) {
      const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
      const node = listener.renderFunction(
        nextBranch,
        listener.value as $FlowFixMe,
      );
      const completed = completeBranch(nextBranch, node);
      alternate.child = completed;
    }
    if (alternate.status !== 'resolved') {
      queueViewMutationAlternate(listener, FLAG_ALTERNATE_VIEW_CHILD);
      alternate.status = 'resolved';
    }
  }
  alternate.promise = promise;
}

export function applyAwaitViewMutations<T>(listener: AwaitElement<T>): void {
  const anchor = listener.anchor;
  const parentNode = anchor.parentNode as $FlowFixMe as Node;
  if (
    listener.status === 'resolved' &&
    listener.child !== null &&
    !listener.child.mounted
  ) {
    attachChildBefore(
      parentNode,
      listener.child.branch.node as $FlowFixMe,
      anchor,
    );
  }
}

export function applyAwaitViewMutationsAlternate<T>(
  listener: AwaitElement<T>,
): void {
  const alternate = listener.alternate;
  if (alternate == null) {
    console.warn(`applyAwaitViewMutationsAlternate() no alternate`);
    return;
  }
  const anchor = listener.anchor;
  const parentNode = anchor.parentNode as $FlowFixMe as Node;
  if (alternate.status === 'resolved') {
    const alternateChild = alternate.child;
    if (alternateChild !== null) {
      if (listener.child !== null) {
        throw new Error('oops, reconcile the two children');
      }
      listener.child = {
        branch: alternateChild,
        mounted: true,
      };
      attachChildBefore(parentNode, alternateChild.node as $FlowFixMe, anchor);
    }
  }
  listener.promise = alternate.promise;
  listener.status = alternate.status;
  listener.alternate = null;
}

function suspend<T>(listener: AwaitElement<T>, promise: Promise<T>): void {
  promise.then(
    value => {
      resolvePendingPromise(listener, promise);
      resume(listener, promise, value);
    },
    error => {
      resolvePendingPromise(listener, promise);
      // TODO: error boundaries
      console.error(error);
      throw error;
    },
  );

  const suspenseBoundary = getSuspenseBoundary(listener);
  // NOTE: suspend() can only happen as part of an existing update
  enqueueUpdate(suspenseBoundary.pending, count => count + 1);

  queuePendingPromise(listener, promise);
}

function resume<T>(
  listener: AwaitElement<T>,
  promise: Promise<T>,
  value: T,
): void {
  if (hasFlag(listener.state, FLAG_INACTIVE) || promise !== listener.promise) {
    // Component unmounted or the promise has changed since we awaited it,
    // nothing to do
    return;
  }
  const suspenseBoundary = getSuspenseBoundary(listener);

  // If we suspended as part of a low-priority transition, and that transition is
  // still pending, we want to try resuming it. If the transition was cancelled,
  // then we likely already changed what promise we're looking at or the listener
  // got unmounted anyway (FLAG_INACTIVE case). If we didn't suspend as part of a
  // transition in the first place, then we need to start a synchronour flush of
  // the resumption.
  enqueueUpdate(listener.value, value);
  enqueueUpdate(suspenseBoundary.pending, count => count - 1);
}

function getSuspenseBoundary(
  listener: AwaitElement<AnyValue>,
): SuspenseElement {
  let current: BranchParent | null = listener.parent;
  while (current != null) {
    if (current.$$type === SUSPENSE_ELEMENT_TYPE) {
      return current;
    }
    current = current.parent;
  }
  // TODO: handle suspense that bubbles to the root, likely with an automatic
  // SuspenseElement at the root
  throw new Error(
    'Could not resolve suspense boundary: await may only be used within a suspense boundary',
  );
}
