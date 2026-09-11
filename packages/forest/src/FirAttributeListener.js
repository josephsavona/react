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
  AttributeListener,
  Compute,
  ReactiveCompute,
} from './FirTypes';
import {
  UNINITIALIZED_COMPUTE_VALUE,
  type UninitializedComputeValue,
} from './FirUninitializedComputeValue';

import {
  addObserver,
  isReactiveCompute,
  readReactive,
  removeObserver,
} from './FirCreators';
import {isAlternate} from './FirMode';
import {initializeCompute} from './FirRunners';
// $FlowFixMe[untyped-import]
import {setValueForStyles} from './FirSetValueForStyles';
import {
  ATTRIBUTE_LISTENER_TYPE,
  DEFAULT_LISTENER_STATE,
  FLAG_CREATED_IN_ALTERNATE,
  readStatic,
} from './FirTypes';

export function maybeAttachAttribute<T>(
  parent: AnyBranch,
  element: Node,
  attribute: string,
  source: Compute<T>,
): void {
  if (!isReactiveCompute(source)) {
    setAttributeValue(
      element,
      attribute,
      readStatic(source),
      UNINITIALIZED_COMPUTE_VALUE,
    );
    return;
  }
  attachAttribute(parent, element, attribute, source);
}

export function attachAttribute<T>(
  parent: AnyBranch,
  element: Node,
  attribute: string,
  source: ReactiveCompute<T>,
): void {
  initializeCompute(source);
  const value = readReactive(source);
  const $: AttributeListener<T> = {
    $$type: ATTRIBUTE_LISTENER_TYPE,
    parent,
    element,
    source,
    previous: value,
    attribute,
    state: isAlternate() ? FLAG_CREATED_IN_ALTERNATE : DEFAULT_LISTENER_STATE,
  };
  parent.views.push($);
  addObserver($, source);

  setAttributeValue(element, attribute, value, UNINITIALIZED_COMPUTE_VALUE);
}

export function applyAttributeListenerMutations<T>(
  listener: AttributeListener<T>,
): void {
  const value = readReactive(listener.source);
  const previous = listener.previous;
  setAttributeValue(listener.element, listener.attribute, value, previous);
  listener.previous = value;
}

export function setAttributeValue<T>(
  element: Node,
  attribute: string,
  value: T,
  previous: T | UninitializedComputeValue,
): void {
  switch (attribute) {
    case 'onClick': {
      if (previous !== UNINITIALIZED_COMPUTE_VALUE) {
        element.removeEventListener('click', previous as $FlowFixMe);
      }
      element.addEventListener('click', value as $FlowFixMe);
      break;
    }
    case 'class': {
      (element as $FlowFixMe).className = value as $FlowFixMe;
      break;
    }
    case 'id': {
      (element as $FlowFixMe).id = value as $FlowFixMe;
      break;
    }
    case 'href': {
      (element as $FlowFixMe).href = value as $FlowFixMe;
      break;
    }
    case 'value': {
      const strValue = '' + (value: $FlowFixMe);
      if (
        strValue !== '' ||
        (previous !== UNINITIALIZED_COMPUTE_VALUE && value !== previous)
      ) {
        (element as $FlowFixMe).value = value as $FlowFixMe;
      }
      break;
    }
    case 'style': {
      setValueForStyles(
        element,
        value,
        previous !== UNINITIALIZED_COMPUTE_VALUE ? previous : undefined,
      );
      break;
    }
    default: {
      throw new Error(`Unsupported attribute '${attribute}'`);
    }
  }
}

export function cleanupAttributeListener<T>(
  listener: AttributeListener<T>,
): void {
  removeObserver(listener, listener.source);
  const previous = listener.previous;
  if (previous === UNINITIALIZED_COMPUTE_VALUE) {
    return;
  }
  switch (listener.attribute) {
    case 'onClick': {
      listener.element.removeEventListener('click', previous as $FlowFixMe);
      break;
    }
    case 'value':
    case 'class':
    case 'style':
    case 'href':
    case 'id': {
      break;
    }
    default: {
      throw new Error(`Unsupported attribute '${listener.attribute}'`);
    }
  }
}
