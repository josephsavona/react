/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {
  AnyValue,
  CompletedBranch,
  Flag,
  ListElementChild,
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
  FLAG_PENDING_VIEW_CHILD,
  FLAG_PENDING_VIEW_SELF,
  FLAG_PENDING_SYNC_CHILD,
  FLAG_PENDING_SYNC_SELF,
  FLAG_INACTIVE,
  FLAG_CREATED_IN_ALTERNATE,
  SUSPENSE_ELEMENT_TYPE,
  AWAIT_ELEMENT_TYPE,
} from './FirTypes';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';
import {hasFlag} from './FirWorkloop';

export function printBranchSummary(branch: CompletedBranch): string {
  const anyBranch = branch as $FlowFixMe;
  let branchId: number;
  if (typeof anyBranch.id === 'number') {
    branchId = anyBranch.id;
  } else {
    branchId = anyBranch.id = _nextBranchId++;
  }
  return `Branch ${branchId} ${printState(branch.state)}`;
}

export function printBranch(branch: CompletedBranch): string {
  const buffer: Array<string> = [];
  writeBranch(branch, buffer);
  return buffer.join('\n');
}
let _nextBranchId = 0;
function writeBranch(
  branch: CompletedBranch,
  buffer: Array<string>,
  depth: number = 0,
): void {
  const anyBranch = branch as $FlowFixMe;
  let branchId: number;
  if (typeof anyBranch.id === 'number') {
    branchId = anyBranch.id;
  } else {
    branchId = anyBranch.id = _nextBranchId++;
  }

  const prefix = '  '.repeat(depth);
  const prefix1 = '  '.repeat(depth + 1);
  const prefix2 = '  '.repeat(depth + 2);
  buffer.push(`${prefix}Branch #${branchId} ${printState(branch.state)} {`);
  buffer.push(`${prefix1}values: `);
  for (let i = 0; i < branch.values.length; i++) {
    const compute = branch.values[i];
    buffer.push(
      `${prefix2}ComputeValue ${JSON.stringify(compute.$value as $FlowFixMe)} ${printState(compute.state)}`,
    );
    if (compute.alternate != null) {
      buffer.push(
        `${prefix2}↳ alternate ${JSON.stringify(compute.alternate.value as $FlowFixMe)}`,
      );
    }
  }
  buffer.push(`${prefix1}computes: `);
  for (let i = 0; i < branch.computes.length; i++) {
    const compute = branch.computes[i];
    switch (compute.$$type) {
      case COMPUTE_UNIT_TYPE: {
        buffer.push(
          `${prefix2}ComputeUnit ${JSON.stringify(compute.$value as $FlowFixMe)} ${printState(compute.state)}`,
        );
        break;
      }
      case COMPUTE_STORE_TYPE: {
        buffer.push(
          `${prefix2}ComputeStore ${compute.$value as $FlowFixMe} ${compute.$pending === UNINITIALIZED_COMPUTE_VALUE ? '<uninit>' : (compute.$pending as $FlowFixMe)} ${printState(compute.state)}`,
        );
        break;
      }
      default: {
        compute as empty;
      }
    }
    if (compute.alternate != null) {
      buffer.push(
        `${prefix2}↳ alternate ${JSON.stringify(compute.alternate.value as $FlowFixMe)}`,
      );
    }
  }
  buffer.push(`${prefix1}views: `);
  for (let i = 0; i < branch.views.length; i++) {
    const compute = branch.views[i];
    switch (compute.$$type) {
      case TEXT_LISTENER_TYPE: {
        buffer.push(
          `${prefix2}TextListener ${compute.text.textContent} ${printState(compute.state)}`,
        );
        break;
      }
      case ATTRIBUTE_LISTENER_TYPE: {
        buffer.push(
          `${prefix2}AttributeListener ${compute.attribute} ${printState(compute.state)}`,
        );
        break;
      }
      default: {
        compute as empty;
      }
    }
  }
  buffer.push(`${prefix1}children: `);
  for (let i = 0; i < branch.children.length; i++) {
    const listener = branch.children[i];
    switch (listener.$$type) {
      case CONDITIONAL_ELEMENT_TYPE: {
        buffer.push(
          `${prefix2}ConditionalElementListener ${JSON.stringify(listener.value as $FlowFixMe)} ${printState(listener.state)}`,
        );
        const alternate = listener.alternate;
        if (alternate != null) {
          buffer.push(
            `${prefix2}↳ alternate ${JSON.stringify(alternate.value as $FlowFixMe)}`,
          );
          writeBranch(alternate.child as $FlowFixMe, buffer, depth + 4);
        }
        writeBranch(listener.child as $FlowFixMe, buffer, depth + 3);
        break;
      }
      case LIST_ELEMENT_TYPE: {
        buffer.push(
          `${prefix2}ListElementListener ${JSON.stringify(listener.value as $FlowFixMe)} ${printState(listener.state)}`,
        );
        const alternate = listener.alternate;
        if (alternate != null) {
          buffer.push(
            `${prefix2}↳ alternate ${JSON.stringify(alternate.value as $FlowFixMe)}`,
          );
          const children = alternate.children as $FlowFixMe;
          for (let i = 0; i < children.length; i++) {
            buffer.push(`${prefix2}  ↳ ${children[i].child.key}`);
            if (children[i].alternate) {
              writeBranch(children[i].child.branch, buffer, depth + 5);
            }
          }
        }
        const children: Array<ListElementChild<AnyValue>> =
          listener.children as $FlowFixMe;
        for (let i = 0; i < children.length; i++) {
          writeBranch(children[i].branch, buffer, depth + 3);
        }
        break;
      }
      case CONTEXT_PROVIDER_TYPE: {
        buffer.push(`${prefix2}ContextProvider ${printState(listener.state)}`);
        writeBranch(listener.child as $FlowFixMe, buffer, depth + 3);
        break;
      }
      case SUSPENSE_ELEMENT_TYPE: {
        buffer.push(
          `${prefix2}SuspenseElement ${listener.status} ${listener.pending.$value} ${printState(listener.state)}`,
        );
        if (listener.fallbackChild !== null) {
          writeBranch(listener.fallbackChild.branch, buffer, depth + 3);
        }
        if (listener.child !== null) {
          writeBranch(listener.child, buffer, depth + 3);
        }
        break;
      }
      case AWAIT_ELEMENT_TYPE: {
        buffer.push(
          `${prefix2}AwaitElement ${listener.status} ${JSON.stringify(listener.value.$value as $FlowFixMe)} ${printState(listener.state)}`,
        );
        if (listener.child !== null) {
          writeBranch(listener.child.branch, buffer, depth + 3);
        }
        break;
      }
      default: {
        listener as empty;
      }
    }
  }
  buffer.push(`${prefix1}effects: `);
  for (let i = 0; i < branch.effects.length; i++) {
    const effect = branch.effects[i];
    buffer.push(`${prefix2}Effect ${printState(effect.state)}`);
  }
  buffer.push(`${prefix}}`);
}

export function printState(flag: Flag): string {
  return [
    hasFlag(flag, FLAG_PENDING_SYNC_SELF) ? 'S' : '_',
    hasFlag(flag, FLAG_PENDING_SYNC_CHILD) ? 's' : '_',
    hasFlag(flag, FLAG_PENDING_VIEW_SELF) ? 'V' : '_',
    hasFlag(flag, FLAG_PENDING_VIEW_CHILD) ? 'v' : '_',
    hasFlag(flag, FLAG_PENDING_EFFECT_SELF) ? 'E' : '_',
    hasFlag(flag, FLAG_PENDING_EFFECT_CHILD) ? 'e' : '_',
    hasFlag(flag, FLAG_INACTIVE) ? 'I' : '_',
    '.',
    hasFlag(flag, FLAG_CREATED_IN_ALTERNATE) ? 'X' : '_',
    hasFlag(flag, FLAG_ALTERNATE_SYNC_SELF) ? 'A' : '__',
    hasFlag(flag, FLAG_ALTERNATE_SYNC_CHILD) ? 'a' : '__',
    hasFlag(flag, FLAG_ALTERNATE_VIEW_SELF) ? 'C' : '_',
    hasFlag(flag, FLAG_ALTERNATE_VIEW_CHILD) ? 'c' : '_',
    hasFlag(flag, FLAG_ALTERNATE_EFFECT_SELF) ? 'F' : '_',
    hasFlag(flag, FLAG_ALTERNATE_EFFECT_CHILD) ? 'f' : '_',
  ].join('');
}
