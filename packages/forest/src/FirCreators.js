/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {
  Fragment,
  BranchParent,
  CompletedBranch,
  AnyBranch,
  AnyObserver,
  AnyReactiveCompute,
  AnyValue,
  Branch,
  Compute,
  ComputeStore,
  ComputeUnit,
  ComputeValue,
  ReactiveCompute,
  ReactNode,
  ComputeAlternate,
} from './FirTypes';

import {initializeCompute} from './FirRunners';
import {
  BRANCH_TYPE,
  COMPUTE_STORE_TYPE,
  COMPUTE_UNIT_TYPE,
  COMPUTE_VALUE_TYPE,
  DEFAULT_BRANCH_STATE,
  DEFAULT_COMPUTE_STATE,
  FRAGMENT_TYPE,
  staticValue,
  FLAG_CREATED_IN_ALTERNATE,
  COMPUTE_ALTERNATE_TYPE,
} from './FirTypes';
import {isAlternate} from './FirMode';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';

export function createRootBranch<Root>(): Branch<Root> {
  return {
    $$type: BRANCH_TYPE,
    root: null,
    parent: null,
    values: [],
    computes: [],
    views: [],
    children: [],
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_BRANCH_STATE,
    effects: [],
    events: [],
    node: UNINITIALIZED_COMPUTE_VALUE,
  };
}
export function createBranch<Root>(
  parent: BranchParent,
  root: Root,
): Branch<Root> {
  return {
    $$type: BRANCH_TYPE,
    root: root,
    parent,
    values: [],
    computes: [],
    views: [],
    children: [],
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_BRANCH_STATE,
    effects: [],
    events: [],
    node: UNINITIALIZED_COMPUTE_VALUE,
  };
}

export function completeBranch(
  branch: AnyBranch,
  node: ReactNode,
): CompletedBranch {
  if (branch.node !== UNINITIALIZED_COMPUTE_VALUE) {
    throw new Error('Branch already completed');
  }
  branch.node = node;
  return branch as $FlowFixMe;
}

export function createFragment(children: Array<ReactNode>): Fragment {
  return {
    $$type: FRAGMENT_TYPE,
    children,
  };
}

export type ComputeSetter<T> = (next: T | ((prev: T) => T)) => void;
export function createComputeValue<T>(
  parent: AnyBranch,
  init: T,
): ComputeValue<T> {
  const $: ComputeValue<T> = {
    $$type: COMPUTE_VALUE_TYPE,
    $value: init,
    observers: [],
    parent,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_COMPUTE_STATE,
    alternate: null,
  };
  parent.values.push($);
  return $;
}

export function createComputeUnit<T>(
  parent: AnyBranch,
  fn: () => T,
  sources: Array<AnyReactiveCompute>,
): ComputeUnit<T> {
  const $: ComputeUnit<T> = {
    $$type: COMPUTE_UNIT_TYPE,
    fn,
    $value: UNINITIALIZED_COMPUTE_VALUE,
    observers: [],
    parent,
    sources,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_COMPUTE_STATE,
    alternate: null,
  };
  parent.computes.push($);
  return $;
}

export function maybeComputeUnit<T>(
  parent: AnyBranch,
  fn: () => T,
  sources: Array<Compute<AnyValue>>,
): Compute<T> {
  let $: ComputeUnit<T> | null = null;
  let reactiveSources: Array<AnyReactiveCompute> | null = null;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (isReactiveCompute(source)) {
      if ($ === null) {
        // Lazily create the computed unit
        $ = {
          $$type: COMPUTE_UNIT_TYPE,
          fn,
          $value: UNINITIALIZED_COMPUTE_VALUE,
          observers: [],
          parent,
          sources: null as $FlowFixMe,
          state: isAlternate()
            ? FLAG_CREATED_IN_ALTERNATE
            : DEFAULT_COMPUTE_STATE,
          alternate: null,
        };
      }
      if (reactiveSources !== null) {
        reactiveSources.push(source);
      }
    } else if (reactiveSources === null) {
      // $FlowFixMe[incompatible-type] already checked these items are reactive
      reactiveSources = sources.slice(0, i);
    }
  }
  if ($ !== null) {
    // If reactiveSources is null, it means all the input sources were reactive
    // and we can use the existing array
    // $FlowFixMe[incompatible-type]
    const checkedSources: Array<AnyReactiveCompute> =
      reactiveSources !== null ? reactiveSources : (sources: $FlowFixMe);
    $.sources = checkedSources;
    parent.computes.push($);
    return $;
  }
  return staticValue(fn());
}

export function cleanupComputeUnit<T>(compute: ComputeUnit<T>): void {
  const sources = compute.sources;
  for (let i = 0; i < sources.length; i++) {
    removeObserver(compute, sources[i]);
  }
}

export function createComputeStore<T>(
  parent: AnyBranch,
  value: T,
): ComputeStore<T> {
  const $: ComputeStore<T> = {
    $$type: COMPUTE_STORE_TYPE,
    $pending: UNINITIALIZED_COMPUTE_VALUE,
    $value: value,
    observers: [],
    parent,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_COMPUTE_STATE,
    alternate: null,
  };
  parent.computes.push($);
  return $;
}

export function createAlternate<T>(
  compute: ReactiveCompute<T>,
): ComputeAlternate<T> {
  return {
    $$type: COMPUTE_ALTERNATE_TYPE,
    value: UNINITIALIZED_COMPUTE_VALUE,
  };
}

export function getOrCreateAlternate<T>(
  compute: ReactiveCompute<T>,
): ComputeAlternate<T> {
  let alternate: ComputeAlternate<T> | null = compute.alternate;
  if (alternate === null) {
    alternate = compute.alternate = {
      $$type: COMPUTE_ALTERNATE_TYPE,
      value: UNINITIALIZED_COMPUTE_VALUE,
    };
  }
  return alternate;
}

export function addObserver(
  observer: AnyObserver,
  source: AnyReactiveCompute,
): void {
  source.observers.push(observer);
}

export function removeObserver(
  observer: AnyObserver,
  source: AnyReactiveCompute,
): void {
  retainExcept(source.observers, observer);
}

/**
 * Modifies @param items in-place to remove any instances of @param except.
 */
function retainExcept<T>(items: Array<T>, except: T): void {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < items.length; readIndex++) {
    const item = items[readIndex];
    if (item !== except) {
      items[writeIndex++] = item;
    }
  }
  items.length = writeIndex;
}

/************* CREATORS (LISTENERS) *****************/

// CONSUMERS

export function isReactiveCompute(
  compute: Compute<AnyValue>,
  // $FlowFixMe[incompatible-type-guard]
): compute is AnyReactiveCompute {
  if (
    compute != null &&
    typeof compute === 'object' &&
    // $FlowFixMe[method-unbinding]
    Object.prototype.hasOwnProperty.call(compute, '$$type')
  ) {
    return true;
  }
  return false;
}

export function read<T>(compute: Compute<T>): T {
  if (isReactiveCompute(compute)) {
    if (__DEV__) {
      if ((compute as $FlowFixMe).$value === UNINITIALIZED_COMPUTE_VALUE) {
        throw new Error('reading uninitialized compute');
      }
    }
    if (isAlternate()) {
      const alternate = compute.alternate;
      if (alternate !== null) {
        if (__DEV__) {
          if (alternate.value === UNINITIALIZED_COMPUTE_VALUE) {
            throw new Error(
              'Expected alternate to always be initialized with a value',
            );
          }
        }
        return alternate.value as $FlowFixMe;
      }
    }
    return (compute as $FlowFixMe).$value as T;
  }
  // static value
  return compute as $FlowFixMe;
}

export function readReactive<T>(compute: ReactiveCompute<T>): T {
  if (__DEV__) {
    if (compute.$value === UNINITIALIZED_COMPUTE_VALUE) {
      throw new Error('reading uninitialized compute');
    }
  }
  if (isAlternate()) {
    const alternate = compute.alternate;
    if (alternate !== null) {
      if (__DEV__) {
        if (alternate.value === UNINITIALIZED_COMPUTE_VALUE) {
          throw new Error(
            'Expected alternate to always be initialized with a value',
          );
        }
      }
      return alternate.value as $FlowFixMe;
    }
  }
  return compute.$value as $FlowFixMe;
}

export function readAndInitialize<T>(compute: Compute<T>): T {
  if (!isReactiveCompute(compute)) {
    return compute as $FlowFixMe;
  }
  initializeCompute(compute);
  return readReactive(compute);
}
