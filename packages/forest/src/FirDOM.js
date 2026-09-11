/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {AnyValue, AnyBranch, ReactNode} from './FirTypes';
import {createSuspense} from './FirAsync';
import {createConditionalElement} from './FirConditionalElement';
import {ensureActiveTransition} from './FirScheduler';
import {createState} from './FirState';
import {render} from './FirWorkloop';

export interface FirRoot {
  render<T>(
    component: (branch: AnyBranch, props: T) => ReactNode,
    props: T,
  ): void;

  unmount(): void;
}

export interface FirStaticRoot {
  unmount(): void;
}

export function createRoot(el: Node): FirRoot {
  let unmount: (() => void) | null = null;
  let setState;
  const initialize = (
    branch: AnyBranch,
    {init}: {init: {component: AnyValue, props: AnyValue}},
  ) => {
    const [$state, _setState] = createState(branch, init);
    setState = _setState;
    return createSuspense(
      branch,
      () => {
        console.warn('A component suspended without a <Suspense> boundary');
        return document.createElement('div');
      },
      branch => {
        return createConditionalElement(branch, $state, (branch, state) => {
          const {component, props} = state;
          return component(branch, props);
        });
      },
    );
  };
  return {
    render(component, props) {
      if (unmount == null) {
        ensureActiveTransition();
        unmount = render(el, initialize, {init: {component, props}});
      } else {
        setState({component, props});
      }
    },
    unmount(): void {
      if (unmount != null) {
        unmount();
        unmount = null;
      }
    },
  };
}

export function createStaticRoot(
  el: Node,
  component: (branch: AnyBranch, props: {}) => ReactNode,
): FirStaticRoot {
  ensureActiveTransition();
  let unmount: (() => void) | null = render(
    el,
    branch => {
      return createSuspense(
        branch,
        () => {
          console.warn('A component suspended without a <Suspense> boundary');
          return document.createElement('div');
        },
        branch => {
          return component(branch, {});
        },
      );
    },
    undefined,
  );
  return {
    unmount() {
      if (unmount != null) {
        unmount();
        unmount = null;
      }
    },
  };
}
