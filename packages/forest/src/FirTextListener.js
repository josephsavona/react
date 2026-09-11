/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {AnyBranch, Compute, TextListener} from './FirTypes';

import {
  addObserver,
  isReactiveCompute,
  readReactive,
  removeObserver,
} from './FirCreators';
import {isAlternate} from './FirMode';
import {initializeCompute} from './FirRunners';
import {
  DEFAULT_LISTENER_STATE,
  FLAG_CREATED_IN_ALTERNATE,
  TEXT_LISTENER_TYPE,
  readStatic,
} from './FirTypes';

export function createText(parent: AnyBranch, source: Compute<string>): Text {
  if (!isReactiveCompute(source)) {
    // $FlowFixMe[extra-arg]
    return new Text(readStatic(source));
  }

  initializeCompute(source);
  const $: TextListener = {
    $$type: TEXT_LISTENER_TYPE,
    parent,
    source,
    // $FlowFixMe[extra-arg]
    text: new Text(readReactive(source)),
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_LISTENER_STATE,
  };
  parent.views.push($);
  addObserver($, source);

  return $.text;
}

export function applyTextListenerMutations(listener: TextListener): void {
  const value = readReactive(listener.source);
  listener.text.textContent = value;
}

export function cleanupTextListener(listener: TextListener): void {
  removeObserver(listener, listener.source);
}
