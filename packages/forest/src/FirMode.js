/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

let _isAlternateModeActive = false;

export function isAlternate(): boolean {
  return _isAlternateModeActive;
}

export function setMode(mode: 'sync' | 'alternate'): void {
  _isAlternateModeActive = mode === 'alternate';
}
