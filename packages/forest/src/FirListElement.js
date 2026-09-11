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
  ReactiveCompute,
  ReactNode,
  AnyValue,
  ListElementChild,
  ListElementListener,
  ComputeStore,
  ListElementAlternateChild,
} from './FirTypes';

import {
  addObserver,
  completeBranch,
  createBranch,
  createComputeStore,
  readReactive,
  removeObserver,
  getOrCreateAlternate,
} from './FirCreators';
import {isAlternate} from './FirMode';
import {
  attachChildBefore,
  initializeCompute,
  revertAlternate,
} from './FirRunners';
import {
  LIST_ELEMENT_TYPE,
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
  queueObservers,
  queueViewMutation,
  unsetFlag,
  queueViewMutationAlternate,
  queueObserversAlternate,
  markAlternateBranchAsAttached,
} from './FirWorkloop';

export function createListElement<T>(
  parent: AnyBranch,
  source: ReactiveCompute<Array<T>>,
  keyFunction: (item: T) => string | number,
  renderFunction: (branch: AnyBranch, item: ComputeStore<T>) => ReactNode,
): ListElementListener<T> {
  // $FlowFixMe[extra-arg]
  const comment = new Comment('');
  const $: ListElementListener<T> = {
    $$type: LIST_ELEMENT_TYPE,
    parent,
    value: UNINITIALIZED_COMPUTE_VALUE,
    children: null,
    anchor: comment,
    keyFunction,
    renderFunction,
    source,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_LISTENER_STATE,
    pendingRemoval: null,
    pendingAddition: null,
    alternate: null,
  };
  parent.children.push($);
  initializeCompute(source);
  addObserver($, source);
  return $;
}

export function runListElementListener<T>(
  listener: ListElementListener<T>,
): void {
  const anchor = listener.anchor;
  const parentNode = anchor.parentNode as $FlowFixMe as Node;
  const previousChildren = listener.children;
  const keyFunction = listener.keyFunction;
  const renderFunction = listener.renderFunction;
  const items = readReactive(listener.source);
  listener.value = items;
  if (previousChildren === null) {
    // First run
    const children: ListElementListener<T>['children'] = items.map(item => {
      const key = keyFunction(item);
      const branch = createBranch<AnyValue>(listener, listener.parent.root);
      const store = createComputeStore(branch, item);
      const node = renderFunction(branch, store);
      attachChildBefore(parentNode, node, anchor);

      return {
        key,
        store,
        branch: completeBranch(branch, node),
      };
    });
    listener.children = children;
  } else {
    queueViewMutation(listener, FLAG_PENDING_VIEW_CHILD);
    let nextIndex = 0;
    const prevChildren: Array<ListElementChild<T>> =
      previousChildren as $FlowFixMe;
    // Update items for prefixes of the same keys
    for (; nextIndex < items.length; nextIndex++) {
      const prevChild = prevChildren[nextIndex];
      if (prevChild == null) {
        break;
      }
      const item = items[nextIndex];
      const key = keyFunction(item);
      if (key === prevChild.key) {
        if (item !== prevChild.store.$value) {
          prevChild.store.$pending = item;
          queueObservers(prevChild.store.observers);
        }
      } else {
        break;
      }
    }
    // If we've reached the end of new children, delete any remaining old children
    if (nextIndex === items.length) {
      while (nextIndex < prevChildren.length) {
        const last: ListElementChild<T> = prevChildren.pop() as $FlowFixMe;
        unlinkBranch(last.branch);
        listener.pendingRemoval ??= [];
        listener.pendingRemoval.push(last.branch.node as $FlowFixMe);
      }
      return;
    }
    // If no more existing children, append new items
    if (nextIndex === prevChildren.length) {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        const key = keyFunction(item);
        const branch = createBranch<AnyValue>(listener, listener.parent.root);
        const store = createComputeStore(branch, item);
        const node = renderFunction(branch, store);
        listener.pendingAddition ??= [];
        listener.pendingAddition.push(node);

        prevChildren.push({
          key,
          store,
          branch: completeBranch(branch, node),
        });
      }
      return;
    }

    // "Move" any remaining existing children into a map (add them to a map and
    // then prune the array), we'll add back any whose keys are still present
    // as we encounter them and then delete the rest
    const keyMap: Map<string | number, ListElementChild<T>> = new Map();
    for (let i = nextIndex; i < previousChildren.length; i++) {
      const prevChild = prevChildren[i];
      keyMap.set(prevChild.key, prevChild);
    }
    previousChildren.length = nextIndex;

    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      const key = keyFunction(item);
      const prevChild = keyMap.get(key);
      if (prevChild !== undefined) {
        if (item !== prevChild.store.$value) {
          prevChild.store.$pending = item;
          queueObservers(prevChild.store.observers);
        }
        keyMap.delete(key);
        previousChildren.push(prevChild);
      } else {
        const branch = createBranch<AnyValue>(listener, listener.parent.root);
        const store = createComputeStore(branch, item);
        const node = renderFunction(branch, store);
        listener.pendingAddition ??= [];
        // TODO: this happens to work bc we only append when we shuffle keys,
        // but in practice each addition needs to know what it's "next" node
        // is so that we can do an insertBefore in the viewmutation.
        listener.pendingAddition.push(node);

        prevChildren.push({
          key,
          store,
          branch: completeBranch(branch, node),
        });
      }
    }
    for (const prevChild of keyMap.values()) {
      unlinkBranch(prevChild.branch);
      listener.pendingRemoval ??= [];
      listener.pendingRemoval.push(prevChild.branch.node as $FlowFixMe);
    }
  }
}

export function runListElementListenerAlternate<T>(
  listener: ListElementListener<T>,
): void {
  if (__DEV__) {
    if (
      listener.children === null ||
      listener.value === UNINITIALIZED_COMPUTE_VALUE
    ) {
      throw new Error(
        'Oops, expected runListElementListenerAlternate to only run for updates. ' +
          'This listener has not yet mounted.',
      );
    }
  }

  const items = readReactive(listener.source);

  // If we're somehow back to the starting value, cleanup the pending alternate
  // and reset to mark no alternate changes on self
  if (items === listener.value) {
    const pendingAlternate = listener.alternate;
    if (pendingAlternate !== null) {
      for (let i = 0; i < pendingAlternate.children.length; i++) {
        const child = pendingAlternate.children[i];
        if (child.alternate) {
          // This is a new, pending/alternate child that we now don't need
          unlinkBranch(child.child.branch);
          continue;
        }
        // This is an existing child. If the value for this key had previously changed,
        // then we need to revert out the alternate for it to reset back to the original
        // value.
        const storeAlternate = child.child.store.alternate;
        if (storeAlternate !== null) {
          revertAlternate(child.child.store);
        }
      }
      listener.alternate = null;
    }
    listener.state = unsetFlag(listener.state, FLAG_ALTERNATE_VIEW_SELF);
    return;
  }

  const pendingAlternate = listener.alternate;

  // If the pending alternate is already current, there's nothing to do
  if (pendingAlternate !== null && pendingAlternate.value === items) {
    return;
  }

  // Else the value is different, and we need to reconcile the new items against
  // both the pending alternates and canonical values.
  const keyMap: Map<string | number, ListElementAlternateChild<T>> = new Map();
  const children: Array<ListElementChild<T>> = listener.children as $FlowFixMe;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    keyMap.set(child.key, {alternate: false, child});
  }
  if (pendingAlternate !== null) {
    const pendingChildren = pendingAlternate.children;
    for (let i = 0; i < pendingChildren.length; i++) {
      const child = pendingChildren[i];
      const canonicalChild = keyMap.get(child.child.key);
      if (canonicalChild != null) {
        // We previously created an alternate child for this key, but since then
        // a canonical child has been created, throw away the pending alternate
        // and use the canonical.
        // If this key is still needed, we'll set its value in the loop below
        unlinkBranch(child.child.branch);
      } else {
        keyMap.set(child.child.key, child);
      }
    }
  }

  const keyFunction = listener.keyFunction;
  const renderFunction = listener.renderFunction;
  const alternateChildren: Array<ListElementAlternateChild<T>> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = keyFunction(item);
    const prevChild = keyMap.get(key);
    if (prevChild !== undefined) {
      const store = prevChild.child.store;
      if (prevChild.alternate) {
        // This is a pending alternate *branch*, so we can set its value directly
        if (item !== store.$value) {
          store.$pending = item;
          queueObserversAlternate(store.observers);
        }
      } else {
        // This is an existing (canonical) branch, so we need to set the alternate
        // value for the store
        const canonicalValue = store.$value;
        const alternateItem = store.alternate;
        if (item === canonicalValue) {
          // If the item ended up back at its canonical value, clear the alternate
          // if present
          if (alternateItem !== null) {
            revertAlternate(store);
            store.alternate = null;
          }
        } else {
          // Else update the alternate if its actually changed
          const prevValue =
            alternateItem !== null ? alternateItem.value : canonicalValue;
          if (item !== prevValue) {
            const alternate =
              alternateItem !== null
                ? alternateItem
                : getOrCreateAlternate(store);
            alternate.value = item;
            queueObserversAlternate(store.observers);
          }
        }
      }
      keyMap.delete(key);
      alternateChildren.push(prevChild);
    } else {
      const branch = createBranch<AnyValue>(listener, listener.parent.root);
      const store = createComputeStore(branch, item);
      const node = renderFunction(branch, store);
      listener.pendingAddition ??= [];
      // TODO: this happens to work bc we only append when we shuffle keys,
      // but in practice each addition needs to know what it's "next" node
      // is so that we can do an insertBefore in the viewmutation.
      listener.pendingAddition.push(node);

      alternateChildren.push({
        alternate: true,
        child: {
          key,
          store,
          branch: completeBranch(branch, node),
        },
      });
    }
  }
  const removedChildren: Array<ListElementChild<T>> = [];
  for (const prevChild of keyMap.values()) {
    if (!prevChild.alternate) {
      removedChildren.push(prevChild.child);
    }
  }

  listener.alternate = {
    value: items,
    children: alternateChildren,
    removed: removedChildren,
  };
  queueViewMutationAlternate(listener, FLAG_ALTERNATE_VIEW_CHILD);
}

export function applyListElementListenerMutations<T>(
  listener: ListElementListener<T>,
): void {
  const pendingRemoval = listener.pendingRemoval;
  if (pendingRemoval !== null) {
    for (let i = 0; i < pendingRemoval.length; i++) {
      detachNode(pendingRemoval[i]);
    }
    listener.pendingRemoval = null;
  }
  const pendingAddition = listener.pendingAddition;
  if (pendingAddition !== null) {
    const anchor = listener.anchor;
    const parentNode: Node = anchor.parentNode as $FlowFixMe;
    for (let i = 0; i < pendingAddition.length; i++) {
      attachChildBefore(parentNode, pendingAddition[i], anchor);
    }
    listener.pendingAddition = null;
  }
}

export function applyListElementListenerMutationsAlternate<T>(
  listener: ListElementListener<T>,
): void {
  const pendingAlternate = listener.alternate;
  if (pendingAlternate === null) {
    return;
  }
  for (let i = 0; i < pendingAlternate.removed.length; i++) {
    const child = pendingAlternate.removed[i];
    unlinkBranch(child.branch);
    detachNode(child.branch.node as $FlowFixMe);
  }

  const anchor = listener.anchor;
  const parentNode: Node = anchor.parentNode as $FlowFixMe;
  for (let i = 0; i < pendingAlternate.children.length; i++) {
    const child = pendingAlternate.children[i];
    if (child.alternate) {
      // TODO: we can't just add all the new nodes at the end!
      attachChildBefore(
        parentNode,
        child.child.branch.node as $FlowFixMe,
        anchor,
      );
      markAlternateBranchAsAttached(child.child.branch);
    }
  }

  const children = pendingAlternate.children.map(child => {
    return child.child;
  });
  listener.children = children;
  listener.value = pendingAlternate.value;
  listener.alternate = null;
}

export function cleanupListListener<T>(listener: ListElementListener<T>): void {
  removeObserver(listener, listener.source);
  const children: Array<ListElementChild<AnyValue>> =
    listener.children as $FlowFixMe;
  for (let i = 0; i < children.length; i++) {
    unlinkBranch(children[i].branch);
  }
}
