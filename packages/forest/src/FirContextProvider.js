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
  ReactContext,
  ContextProvider,
  ReactNode,
} from './FirTypes';

import {
  CONTEXT_PROVIDER_TYPE,
  DEFAULT_BRANCH_STATE,
  FLAG_CREATED_IN_ALTERNATE,
} from './FirTypes';
import {isAlternate} from './FirMode';
import {completeBranch, createBranch} from './FirCreators';
import {UNINITIALIZED_COMPUTE_VALUE} from './FirUninitializedComputeValue';

export function contextProvider<T>(
  parent: AnyBranch,
  context: ReactContext<T>,
  value: T,
  cb: (parent: AnyBranch) => ReactNode,
): ContextProvider<AnyValue, T> {
  const $: ContextProvider<AnyValue, T> = {
    $$type: CONTEXT_PROVIDER_TYPE,
    root: parent.root,
    parent,
    context,
    value,
    child: UNINITIALIZED_COMPUTE_VALUE,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_BRANCH_STATE,
  };
  parent.children.push($);
  const branch = createBranch($, parent.root);
  const node = cb(branch);
  $.child = completeBranch(branch, node);
  return $;
}
