/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {AnyBranch, ComputeValue} from './FirTypes';

import {createComputeValue} from './FirCreators';
import {enqueueUpdate} from './FirScheduler';

export type StateSetter<T> = (next: T | (T => T)) => void;
export function createState<T>(
  branch: AnyBranch,
  init: T,
): [ComputeValue<T>, StateSetter<T>] {
  const value = createComputeValue(branch, init);
  const setter = (next: T | (T => T)) => {
    enqueueUpdate(value, next);
  };
  return [value, setter];
}
