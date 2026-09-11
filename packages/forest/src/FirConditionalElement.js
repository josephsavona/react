/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {
  Compute,
  AnyBranch,
  ReactNode,
  AnyValue,
  ConditionalElementListener,
  ReactiveCompute,
} from './FirTypes';

import {
  addObserver,
  completeBranch,
  createBranch,
  isReactiveCompute,
  readReactive,
  removeObserver,
} from './FirCreators';
import {isAlternate} from './FirMode';
import {attachChildBefore, initializeCompute} from './FirRunners';
import {
  CONDITIONAL_ELEMENT_TYPE,
  readStatic,
  FLAG_PENDING_VIEW_CHILD,
  FLAG_ALTERNATE_VIEW_SELF,
  FLAG_ALTERNATE_VIEW_CHILD,
  FLAG_CREATED_IN_ALTERNATE,
  DEFAULT_LISTENER_STATE,
} from './FirTypes';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';
import {
  detachNode,
  unlinkBranch,
  queueViewMutation,
  unsetFlag,
  queueViewMutationAlternate,
  markAlternateBranchAsAttached,
} from './FirWorkloop';

export function maybeConditionalElement<T, U: ReactNode>(
  parent: AnyBranch,
  source: Compute<T>,
  renderFunction: (branch: AnyBranch, item: T) => U,
): ConditionalElementListener<T> | U {
  if (!isReactiveCompute(source)) {
    return renderFunction(parent, readStatic(source));
  }
  return createConditionalElement(parent, source, renderFunction);
}

export function createConditionalElement<T, U: ReactNode>(
  parent: AnyBranch,
  source: ReactiveCompute<T>,
  renderFunction: (branch: AnyBranch, item: T) => U,
): ConditionalElementListener<T> {
  // $FlowFixMe[extra-arg]
  const comment = new Comment('');
  const $: ConditionalElementListener<T> = {
    $$type: CONDITIONAL_ELEMENT_TYPE,
    child: null,
    parent,
    source,
    value: UNINITIALIZED_COMPUTE_VALUE,
    renderFunction,
    anchor: comment,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_LISTENER_STATE,
    pendingRemoval: null,
    alternate: null,
  };
  parent.children.push($);
  initializeCompute(source);
  addObserver($, source);
  return $;
}

export function runConditionalElementListener<T>(
  listener: ConditionalElementListener<T>,
): void {
  const anchor = listener.anchor;
  const parentNode = anchor.parentNode as $FlowFixMe as Node;
  const previousBranch = listener.child;

  const value = readReactive(listener.source);
  const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
  const node = listener.renderFunction(nextBranch, value);
  const completed = completeBranch(nextBranch, node);
  listener.value = value;
  listener.child = completed;
  if (previousBranch !== null) {
    queueViewMutation(listener, FLAG_PENDING_VIEW_CHILD);
    unlinkBranch(previousBranch);
    listener.pendingRemoval = previousBranch.node as $FlowFixMe;
  } else {
    attachChildBefore(parentNode, node, anchor);
  }
}

export function runConditionalElementListenerAlternate<T>(
  listener: ConditionalElementListener<T>,
): void {
  if (__DEV__) {
    if (
      listener.child === null ||
      listener.value === UNINITIALIZED_COMPUTE_VALUE
    ) {
      throw new Error(
        'Oops, expected runConditionalElementListenerAlternate to only run for updates. ' +
          'This listener has not yet mounted.',
      );
    }
  }
  // - read the condition value
  // - if it is the same as the canonical value's current condition value, then:
  //   - unmount the pending branch (if set)
  //   - unmark self as having commit changes (we may have already marked parents, oh well)
  //   - null out the pending alternate
  //   - exit. the low-pri update ended up back where we started.
  // - if there is a current pending alternate, tear it down, we're not going to use it.
  // - create the new branch and store it in a pending alternate.
  // - queueViewMutationAlternate

  const value = readReactive(listener.source);
  if (value === listener.value) {
    // Same as the canonical value, we don't need to change anything! Revert back if we have pending
    // changes and bail
    const previousAlternate = listener.alternate;
    if (previousAlternate !== null) {
      unlinkBranch(previousAlternate.child);
      listener.alternate = null;
    }
    listener.state = unsetFlag(listener.state, FLAG_ALTERNATE_VIEW_SELF);
    return;
  }

  const previousAlternate = listener.alternate;
  if (previousAlternate !== null) {
    // Teardown the pending branch, we're not going to end up using it
    unlinkBranch(previousAlternate.child);
  }

  const nextBranch = createBranch<AnyValue>(listener, listener.parent.root);
  const node = listener.renderFunction(nextBranch, value);
  const completed = completeBranch(nextBranch, node);

  listener.alternate = {
    value,
    child: completed,
  };
  queueViewMutationAlternate(listener, FLAG_ALTERNATE_VIEW_CHILD);
}

export function cleanupConditionListener<T>(
  listener: ConditionalElementListener<T>,
): void {
  removeObserver(listener, listener.source);
  unlinkBranch(listener.child as $FlowFixMe);
}

export function applyConditionalElementListenerMutations<T>(
  listener: ConditionalElementListener<T>,
): void {
  if (listener.pendingRemoval !== null) {
    detachNode(listener.pendingRemoval);
    listener.pendingRemoval = null;
  }
  const anchor = listener.anchor;
  const parentNode: Node = anchor.parentNode as $FlowFixMe;
  attachChildBefore(parentNode, (listener.child as $FlowFixMe).node, anchor);
}

export function applyConditionalElementListenerMutationsAlternate<T>(
  listener: ConditionalElementListener<T>,
): void {
  // Alternate may be null if the condition ended up back where it started due to multiple
  // updates that rebase and resume before committing
  const pendingAlternate = listener.alternate;
  if (pendingAlternate === null) {
    return;
  }
  const child = listener.child;
  if (child !== null) {
    unlinkBranch(child);
    detachNode(child.node as $FlowFixMe);
  }

  listener.value = pendingAlternate.value;
  listener.child = pendingAlternate.child;
  listener.alternate = null;
  const anchor = listener.anchor;
  const parentNode: Node = anchor.parentNode as $FlowFixMe;
  attachChildBefore(parentNode, (listener.child as $FlowFixMe).node, anchor);
  markAlternateBranchAsAttached(listener.child as $FlowFixMe);
}
