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
  ReactChildren,
  ReactNode,
  ComputeUnit,
  AnyReactiveCompute,
  ConditionalElementListener,
  ListElementListener,
  ComputeStore,
  SuspenseElement,
  AwaitElement,
} from './FirTypes';

import {isReactiveCompute} from './Fir';
import {runAwaitElement, runSuspenseElement} from './FirAsync';
import {runConditionalElementListener} from './FirConditionalElement';
import {addObserver, getOrCreateAlternate} from './FirCreators';
import {runListElementListener} from './FirListElement';
import {createText} from './FirTextListener';
import {
  AWAIT_ELEMENT_TYPE,
  FLAG_ALTERNATE_SYNC_SELF,
  ATTRIBUTE_LISTENER_TYPE,
  EFFECT_TYPE,
  CONTEXT_PROVIDER_TYPE,
  CONDITIONAL_ELEMENT_TYPE,
  FRAGMENT_TYPE,
  LIST_ELEMENT_TYPE,
  COMPUTE_UNIT_TYPE,
  COMPUTE_VALUE_TYPE,
  COMPUTE_STORE_TYPE,
  FLAG_ALTERNATE_VIEW_SELF,
  TEXT_LISTENER_TYPE,
  FLAG_ALTERNATE_EFFECT_SELF,
  SUSPENSE_ELEMENT_TYPE,
} from './FirTypes';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';
import {unsetFlag} from './FirWorkloop';

/************* RUNNERS (COMPUTE) *****************/

export function runComputeUnit<T>(compute: ComputeUnit<T>): boolean {
  const prevValue = compute.$value;
  const nextValue = compute.fn(prevValue);
  if (nextValue !== prevValue) {
    compute.$value = nextValue;
    return true;
  }
  return false;
}

export function runComputeUnitAlternate<T>(compute: ComputeUnit<T>): boolean {
  const prevAlternate = compute.alternate;
  const prevValue =
    prevAlternate !== null ? prevAlternate.value : compute.$value;
  const nextValue = compute.fn(prevValue);
  if (nextValue !== prevValue) {
    const alternate =
      prevAlternate !== null ? prevAlternate : getOrCreateAlternate(compute);
    alternate.value = nextValue;
    return true;
  }
  return false;
}

export function runComputeStore<T>(compute: ComputeStore<T>): boolean {
  if (
    compute.$pending !== UNINITIALIZED_COMPUTE_VALUE &&
    compute.$pending !== compute.$value
  ) {
    compute.$value = compute.$pending as $FlowFixMe;
    compute.$pending = UNINITIALIZED_COMPUTE_VALUE;
    return true;
  }
  return false;
}

export function initializeCompute(compute: AnyReactiveCompute): void {
  switch (compute.$$type) {
    case COMPUTE_VALUE_TYPE:
    case COMPUTE_STORE_TYPE: {
      break;
    }
    case COMPUTE_UNIT_TYPE: {
      if (compute.$value === UNINITIALIZED_COMPUTE_VALUE) {
        const sources = compute.sources;
        for (let i = 0; i < sources.length; i++) {
          const source = sources[i];
          addObserver(compute, source);
          initializeCompute(source);
        }
        compute.$value = compute.fn();
      }
      break;
    }
    default: {
      compute as empty;
    }
  }
}

export function attachAnyChild(
  branch: AnyBranch,
  parentNode: Node,
  $children:
    | ReactChildren
    | ReactNode
    | Array<ReactNode>
    | Array<(AnyBranch) => ReactNode>,
): void {
  if (typeof $children === 'function') {
    attachAnyChild(branch, parentNode, $children(branch));
  } else if (Array.isArray($children)) {
    for (const child of $children) {
      attachAnyChild(branch, parentNode, child);
    }
  } else if ($children instanceof Node) {
    parentNode.appendChild($children);
  } else if (typeof $children === 'string' || typeof $children === 'number') {
    parentNode.appendChild(new Text($children as $FlowFixme));
  } else if (
    $children != null &&
    ($children.$$type === COMPUTE_UNIT_TYPE ||
      $children.$$type === COMPUTE_STORE_TYPE)
  ) {
    parentNode.appendChild(createText(branch, $children));
  } else {
    attachChild(parentNode, $children as $FlowFixMe);
  }
}

// attach helpers
export function attachChildren(
  branch: AnyBranch,
  parentNode: Node,
  $children: ReactChildren,
): void {
  if (typeof $children === 'function') {
    const children = $children(branch);
    attachChildrenNodes(parentNode, children);
  } else {
    parentNode.appendChild(createText(branch, $children));
  }
}

export function attachChildrenNodes(
  parentNode: Node,
  children: ReactNode | Array<ReactNode>,
): void {
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      attachChild(parentNode, child);
    }
  } else {
    attachChild(parentNode, children);
  }
}

export function attachChild(parentNode: Node, child: ReactNode): void {
  if (child instanceof Node) {
    parentNode.appendChild(child);
  } else if (child.$$type === CONDITIONAL_ELEMENT_TYPE) {
    attachConditionalElement(parentNode, child);
  } else if (child.$$type === LIST_ELEMENT_TYPE) {
    attachListElement(parentNode, child);
  } else if (child.$$type === CONTEXT_PROVIDER_TYPE) {
    attachChild(parentNode, (child.child as $FlowFixMe).node);
  } else if (child.$$type === SUSPENSE_ELEMENT_TYPE) {
    attachSuspenseElement(parentNode, child);
  } else if (child.$$type === AWAIT_ELEMENT_TYPE) {
    attachAwaitElement(parentNode, child);
  } else if (child.$$type === FRAGMENT_TYPE) {
    const children = child.children;
    for (let i = 0; i < children.length; i++) {
      attachChild(parentNode, children[i]);
    }
  } else {
    child as empty;
    throw new Error('unexpected child type');
  }
}

export function attachChildBefore(
  parentNode: Node,
  child: ReactNode,
  before: Node,
): void {
  if (child == null) {
    return;
  }
  if (child instanceof Node) {
    parentNode.insertBefore(child, before);
  } else if (child.$$type === CONDITIONAL_ELEMENT_TYPE) {
    attachConditionalElement(parentNode, child, before);
  } else if (child.$$type === LIST_ELEMENT_TYPE) {
    attachListElement(parentNode, child, before);
  } else if (child.$$type === CONTEXT_PROVIDER_TYPE) {
    attachChildBefore(parentNode, (child.child as $FlowFixMe).node, before);
  } else if (child.$$type === SUSPENSE_ELEMENT_TYPE) {
    attachSuspenseElement(parentNode, child, before);
  } else if (child.$$type === AWAIT_ELEMENT_TYPE) {
    attachAwaitElement(parentNode, child, before);
  } else if (child.$$type === FRAGMENT_TYPE) {
    const children = child.children;
    for (let i = 0; i < children.length; i++) {
      attachChildBefore(parentNode, children[i], before);
    }
  } else {
    child as empty;
    throw new Error('unexpected child type');
  }
}

export function attachConditionalElement<T>(
  parentNode: Node,
  listener: ConditionalElementListener<T>,
  before: Node | null = null,
): void {
  parentNode.insertBefore(listener.anchor, before);
  runConditionalElementListener(listener);
}

export function attachListElement<T>(
  parentNode: Node,
  listener: ListElementListener<T>,
  before: Node | null = null,
): void {
  parentNode.insertBefore(listener.anchor, before);
  runListElementListener(listener);
}

export function attachSuspenseElement(
  parentNode: Node,
  listener: SuspenseElement,
  before: Node | null = null,
): void {
  parentNode.insertBefore(listener.anchor, before);
  runSuspenseElement(listener);
}

export function attachAwaitElement<T>(
  parentNode: Node,
  listener: AwaitElement<T>,
  before: Node | null = null,
): void {
  parentNode.insertBefore(listener.anchor, before);
  runAwaitElement(listener);
}

/************* RUNNERS (LISTENERS) *****************/

/**
 * Reverts the alternate value on a compute, nulling out the alternate to indicate that nothing
 * has changed after all. Also recursively does the same for observers. Note this is not perfect:
 * we can reset SELF flags, but we can't determine whether it's safe to unset CHILD flags (on
 * parents/branches) without a full check to see if all other nodes/children also ended up reverting.
 *
 * But by reverting at least SELF flags, we shouldn't end up doing _too_ much work. Note that this
 * doesn't have to be perfect because this case should be very rare (we would try to revert at the
 * top level rather than locally).
 */
export function revertAlternate(compute: AnyReactiveCompute): void {
  if (compute.alternate === null) {
    return;
  }
  compute.alternate = null;
  compute.state = unsetFlag(
    compute.state,
    FLAG_ALTERNATE_SYNC_SELF |
      FLAG_ALTERNATE_VIEW_SELF |
      FLAG_ALTERNATE_EFFECT_SELF,
  );
  for (let i = 0; i < compute.observers.length; i++) {
    const observer = compute.observers[i];
    switch (observer.$$type) {
      case SUSPENSE_ELEMENT_TYPE:
      case AWAIT_ELEMENT_TYPE: {
        throw new Error('[todo] revertAlternate() for suspense/await');
      }
      case COMPUTE_STORE_TYPE:
      case EFFECT_TYPE:
      case TEXT_LISTENER_TYPE:
      case ATTRIBUTE_LISTENER_TYPE:
      case CONTEXT_PROVIDER_TYPE: {
        break;
      }
      case LIST_ELEMENT_TYPE: {
        observer.alternate = null;
        break;
      }
      case CONDITIONAL_ELEMENT_TYPE: {
        observer.alternate = null;
        break;
      }
      case COMPUTE_UNIT_TYPE: {
        let hasSourceWithAlternate = false;
        for (let j = 0; j < observer.sources.length; j++) {
          const source = observer.sources[j];
          if (source.alternate !== null) {
            hasSourceWithAlternate = true;
            break;
          }
        }
        if (!hasSourceWithAlternate) {
          revertAlternate(observer);
        }
        break;
      }
      default: {
        observer as empty;
      }
    }
  }
}
