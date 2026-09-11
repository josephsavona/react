/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {AnyBranch, Compute, Effect, EffectFunction} from './FirTypes';

import {
  addObserver,
  isReactiveCompute,
  read,
  removeObserver,
} from './FirCreators';
import {isAlternate} from './FirMode';
import {initializeCompute} from './FirRunners';
import {
  DEFAULT_LISTENER_STATE,
  EFFECT_TYPE,
  FLAG_CREATED_IN_ALTERNATE,
} from './FirTypes';
import {queueEffect, queueEffectAlternate} from './FirWorkloop';

export function createEffect(
  parent: AnyBranch,
  fn: Compute<EffectFunction>,
): void {
  const $: Effect = {
    $$type: EFFECT_TYPE,
    parent,
    effect: fn,
    cleanup: null,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_LISTENER_STATE,
  };
  parent.effects.push($);
  if (isReactiveCompute(fn)) {
    initializeCompute(fn);
    addObserver($, fn);
  }
  if (isAlternate()) {
    queueEffectAlternate($);
  } else {
    queueEffect($);
  }
}

export function runEffect(effect: Effect): void {
  const cleanup = effect.cleanup;
  if (cleanup != null) {
    cleanup();
  }
  const effectFn = read(effect.effect);
  effect.cleanup = effectFn();
}

export function cleanupEffect(effect: Effect): void {
  if (isReactiveCompute(effect.effect)) {
    removeObserver(effect, effect.effect);
  }
  const cleanup = effect.cleanup;
  if (cleanup != null) {
    cleanup();
    effect.cleanup = null;
  }
}
