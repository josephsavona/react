/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {UninitializedComputeValue} from './FirUninitializedComputeValue';

export type Flag = number;
export const FLAG_PENDING_SYNC_SELF = /*      */ 0b00000000000001;
export const FLAG_PENDING_SYNC_CHILD = /*     */ 0b00000000000010;
export const FLAG_PENDING_VIEW_SELF = /*      */ 0b00000000000100;
export const FLAG_PENDING_VIEW_CHILD = /*     */ 0b00000000001000;
export const FLAG_PENDING_EFFECT_SELF = /*    */ 0b00000000010000;
export const FLAG_PENDING_EFFECT_CHILD = /*   */ 0b00000000100000;
export const FLAG_INACTIVE = /*               */ 0b00000001000000;

export const FLAG_CREATED_IN_ALTERNATE = /*   */ 0b00000010000000;
export const FLAG_ALTERNATE_SYNC_SELF = /*    */ 0b00000100000000;
export const FLAG_ALTERNATE_SYNC_CHILD = /*   */ 0b00001000000000;
export const FLAG_ALTERNATE_VIEW_SELF = /*    */ 0b00010000000000;
export const FLAG_ALTERNATE_VIEW_CHILD = /*   */ 0b00100000000000;
export const FLAG_ALTERNATE_EFFECT_SELF = /*  */ 0b01000000000000;
export const FLAG_ALTERNATE_EFFECT_CHILD = /* */ 0b10000000000000;

export const DEFAULT_BRANCH_STATE = 0;
export const DEFAULT_COMPUTE_STATE = 0;
export const DEFAULT_LISTENER_STATE = 0;

export type AnyContext = ReactContext<AnyValue>;
export type ReactContext<T> = {
  $defaultValue: T,
};

export const BRANCH_TYPE = 0;
export type AnyBranch = Branch<AnyValue>;
export type Branch<Root> = {
  $$type: typeof BRANCH_TYPE,
  root: Root | null,
  parent: BranchParent | null,
  values: Array<AnyComputeValue>,
  computes: Array<AnyBranchCompute>,
  views: Array<AnyBranchView>,
  children: Array<AnyChild>,
  effects: Array<Effect>,
  events: Array<AnyEventListener>,
  state: Flag,
  node: ReactNode | UninitializedComputeValue,
};

export type BranchParent =
  | AnyBranch
  | AnyListElementListener
  | AnyConditionalElementListener
  | AnyContextProvider
  | SuspenseElement
  | AnyAwaitElement;

const COMPLETED_BRANCH_SYMBOL: symbol = Symbol();
export type CompletedBranch = AnyBranch & {
  [typeof COMPLETED_BRANCH_SYMBOL]: true,
  node: ReactNode,
};

export type AnyBranchCompute = ComputeUnit<AnyValue> | ComputeStore<AnyValue>;

export type AnyBranchView = TextListener | AnyAttributeListener;

export type AnyChild =
  | AnyConditionalElementListener
  | AnyListElementListener
  | AnyContextProvider
  | SuspenseElement
  | AnyAwaitElement;

export const CONTEXT_PROVIDER_TYPE = 101;
export type AnyContextProvider = ContextProvider<AnyValue, AnyValue>;
export type ContextProvider<Root, T> = {
  $$type: typeof CONTEXT_PROVIDER_TYPE,
  root: Root | null,
  parent: BranchParent,
  context: ReactContext<T>,
  value: T,
  child: CompletedBranch | UninitializedComputeValue,
  state: Flag,
};

export const SUSPENSE_ELEMENT_TYPE = 102;
export type SuspenseElement = {
  $$type: typeof SUSPENSE_ELEMENT_TYPE,
  parent: BranchParent,
  anchor: Comment,
  fallback: (branch: AnyBranch) => ReactNode,
  pending: ComputeValue<number>,
  renderFunction: (branch: AnyBranch) => ReactNode,
  child: CompletedBranch | null,
  fallbackChild: {
    branch: CompletedBranch,
    mounted: boolean,
  } | null,
  status: 'pending' | 'resolved' | 'init',
  alternate: {
    status: 'pending' | 'resolved' | 'init',
  } | null,
  state: Flag,
};

export const AWAIT_ELEMENT_TYPE = 103;
export type AnyAwaitElement = AwaitElement<AnyValue>;
export type AwaitElement<T> = {
  $$type: typeof AWAIT_ELEMENT_TYPE,
  parent: BranchParent,
  anchor: Comment,
  source: ReactiveCompute<Promise<T>>,
  promise: Promise<T> | null,
  value: ComputeValue<T | UninitializedComputeValue>,
  renderFunction: (branch: AnyBranch, value: Compute<T>) => ReactNode,
  child: {branch: CompletedBranch, mounted: boolean} | null,
  status: 'pending' | 'resolved' | 'init',
  alternate: {
    child: CompletedBranch | null,
    status: 'pending' | 'resolved' | 'init',
    promise: Promise<T>,
  } | null,
  state: Flag,
};

export type AnyObserver = AnyBranchCompute | AnyChild | AnyBranchView | Effect;

export const CONDITIONAL_ELEMENT_TYPE = 1;
export type AnyConditionalElementListener =
  ConditionalElementListener<AnyValue>;
export type ConditionalElementListener<T> = {
  $$type: typeof CONDITIONAL_ELEMENT_TYPE,
  parent: AnyBranch,
  anchor: Comment,
  child: CompletedBranch | null,
  source: ReactiveCompute<T>,
  value: T | UninitializedComputeValue,
  renderFunction: (branch: AnyBranch, item: T) => ReactNode,
  state: Flag,
  pendingRemoval: ReactNode | null,
  alternate: ConditionalElementAlternate<T> | null,
};

export type ConditionalElementAlternate<T> = {
  value: T,
  child: CompletedBranch,
};

export const LIST_ELEMENT_TYPE = 2;
export type AnyListElementListener = ListElementListener<AnyValue>;
export type ListElementListener<T> = {
  $$type: typeof LIST_ELEMENT_TYPE,
  parent: AnyBranch,
  anchor: Comment,
  value: Array<T> | UninitializedComputeValue,
  children: Array<ListElementChild<T>> | null,
  keyFunction: (item: T) => string | number,
  renderFunction: (branch: AnyBranch, item: ComputeStore<T>) => ReactNode,
  source: ReactiveCompute<Array<T>>,
  state: Flag,
  pendingRemoval: Array<ReactNode> | null,
  pendingAddition: Array<ReactNode> | null,
  alternate: ListElementAlternate<T> | null,
};
export type ListElementChild<T> = {
  key: string | number,
  store: ComputeStore<T>,
  branch: CompletedBranch,
};

export type ListElementAlternate<T> = {
  value: Array<T>,
  children: Array<ListElementAlternateChild<T>>,
  removed: Array<ListElementChild<T>>,
};
export type ListElementAlternateChild<T> = {
  // is this a new alternate child or reused from the canonical list?
  alternate: boolean,
  child: ListElementChild<T>,
};

export const TEXT_LISTENER_TYPE = 3;
export type TextListener = {
  $$type: typeof TEXT_LISTENER_TYPE,
  parent: AnyBranch,
  text: Text,
  source: ReactiveCompute<string>,
  state: Flag,
};

export const ATTRIBUTE_LISTENER_TYPE = 4;
export type AnyAttributeListener = AttributeListener<AnyValue>;
export type AttributeListener<T> = {
  $$type: typeof ATTRIBUTE_LISTENER_TYPE,
  parent: AnyBranch,
  element: Node,
  attribute: string,
  source: ReactiveCompute<T>,
  previous: T | UninitializedComputeValue,
  state: Flag,
};

export const EVENT_LISTENER_TYPE = 4;
export type AnyEventListener = EventListener<AnyValue>;
export type EventListener<T> = {
  $$type: typeof EVENT_LISTENER_TYPE,
  parent: AnyBranch,
  element: Node,
  event: string,
  handler: T => void,
  state: Flag,
};

export const COMPUTE_UNIT_TYPE = 42;
export type AnyComputeUnit = ComputeUnit<AnyValue>;
export type ComputeUnit<T> = {
  $$type: typeof COMPUTE_UNIT_TYPE,
  $value: T | UninitializedComputeValue,
  fn: (prev: T | UninitializedComputeValue) => T,
  sources: Array<AnyReactiveCompute>,
  observers: Array<AnyObserver>,
  parent: AnyBranch,
  state: Flag,
  alternate: ComputeAlternate<T> | null,
};

export const COMPUTE_VALUE_TYPE = 43;
export type AnyComputeValue = ComputeValue<AnyValue>;
export type ComputeValue<T> = {
  $$type: typeof COMPUTE_VALUE_TYPE,
  $value: T,
  observers: Array<AnyObserver>,
  parent: AnyBranch,
  state: Flag,
  alternate: ComputeAlternate<T> | null,
};

export const COMPUTE_STORE_TYPE = 44;
export type AnyComputeStore = ComputeStore<AnyValue>;
export type ComputeStore<T> = {
  $$type: typeof COMPUTE_STORE_TYPE,
  $value: T,
  $pending: T | UninitializedComputeValue,
  observers: Array<AnyObserver>,
  parent: AnyBranch,
  state: Flag,
  alternate: ComputeAlternate<T> | null,
};

export const COMPUTE_ALTERNATE_TYPE = 45;
export type ComputeAlternate<T> = {
  $$type: typeof COMPUTE_ALTERNATE_TYPE,
  value: T | UninitializedComputeValue,
};

// Hacky workaround: we declare StaticValue as if it was a boxed type,
// but in practice it will always be the static value
export opaque type StaticValue<T> = T;

export function staticValue<T>(value: T): StaticValue<T> {
  return value as $FlowFixMe;
}

export function readStatic<T>(compute: StaticValue<T>): T {
  return compute as $FlowFixMe;
}

export type AnyValue = $FlowFixMe;

export type Compute<T> = StaticValue<T> | ReactiveCompute<T>;

export type ReactiveCompute<T> =
  | ComputeValue<T>
  | ComputeUnit<T>
  | ComputeStore<T>;

export type AnyReactiveCompute = ReactiveCompute<AnyValue>;
export type AnyComputeObserver = ComputeUnit<AnyValue> | ComputeStore<AnyValue>;

export type CleanupFunction = () => void;
export type EffectFunction = () => CleanupFunction | void;

export const EFFECT_TYPE = 1001;
export type Effect = {
  $$type: typeof EFFECT_TYPE,
  parent: AnyBranch,
  effect: Compute<EffectFunction>,
  cleanup: CleanupFunction | null | void,
  state: Flag,
};

export type ReactChildren =
  | Compute<string>
  | ((branch: AnyBranch) => ReactNode | Array<ReactNode>);
export type ReactNode =
  | Node
  | AnyConditionalElementListener
  | AnyListElementListener
  | AnyContextProvider
  | Fragment
  | SuspenseElement
  | AnyAwaitElement;

export const FRAGMENT_TYPE = 10002;
export type Fragment = {
  $$type: typeof FRAGMENT_TYPE,
  children: Array<ReactNode>,
};
