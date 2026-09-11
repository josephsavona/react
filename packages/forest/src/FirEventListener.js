/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {EventListener, AnyBranch, Compute} from './FirTypes';

import {isReactiveCompute, readAndInitialize} from './FirCreators';
import {isAlternate} from './FirMode';
import {
  DEFAULT_LISTENER_STATE,
  EVENT_LISTENER_TYPE,
  FLAG_CREATED_IN_ALTERNATE,
  readStatic,
} from './FirTypes';

export function attachEvent<T>(
  parent: AnyBranch,
  element: Node,
  event: string,
  $handler: Compute<(T) => void>,
): void {
  let staticHandler: T => void;
  if (isReactiveCompute($handler)) {
    staticHandler = (e: T) => {
      const handler = readAndInitialize($handler);
      handler(e);
    };
  } else {
    staticHandler = (e: T) => {
      const handler = readStatic($handler);
      handler(e);
    };
  }
  const $: EventListener<T> = {
    $$type: EVENT_LISTENER_TYPE,
    parent,
    element,
    handler: staticHandler,
    event,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_LISTENER_STATE,
  };
  parent.events.push($);

  element.addEventListener(event as $FlowFixMe, staticHandler as $FlowFixMe);
}

export function cleanupEvent<T>(event: EventListener<T>): void {
  event.element.removeEventListener(
    event.event as $FlowFixMe,
    event.handler as $FlowFixMe,
  );
}
