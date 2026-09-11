/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {AnyBranch, BranchParent, ReactContext} from './FirTypes';

import {CONTEXT_PROVIDER_TYPE} from './FirTypes';

export function createContext<T>($defaultValue: T): ReactContext<T> {
  const context: ReactContext<T> = {$defaultValue};
  return context;
}

export function readContext<T>(branch: AnyBranch, context: ReactContext<T>): T {
  let current: BranchParent | null = branch;
  while (current != null) {
    if (
      current.$$type === CONTEXT_PROVIDER_TYPE &&
      current.context === context
    ) {
      return current.value;
    }
    current = current.parent;
  }
  return context.$defaultValue;
}
