/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactStackTrace} from 'shared/ReactTypes';

import type {
  AsyncSequence,
  IONode,
  PromiseNode,
  UnresolvedPromiseNode,
  AwaitNode,
  UnresolvedAwaitNode,
} from './ReactFlightAsyncSequence';

import {
  IO_NODE,
  PROMISE_NODE,
  UNRESOLVED_PROMISE_NODE,
  AWAIT_NODE,
  UNRESOLVED_AWAIT_NODE,
} from './ReactFlightAsyncSequence';
import {resolveOwner} from './flight/ReactFlightCurrentOwner';
import {resolveRequest, isAwaitInUserspace} from './ReactFlightServer';
import {createHook, executionAsyncId, AsyncResource} from 'async_hooks';
import {enableAsyncDebugInfo} from 'shared/ReactFeatureFlags';
import {parseStackTrace} from './ReactFlightServerConfig';

// $FlowFixMe[method-unbinding]
const getAsyncId = AsyncResource.prototype.asyncId;

const pendingOperations: Map<number, AsyncSequence> =
  __DEV__ && enableAsyncDebugInfo ? new Map() : (null: any);

// This is a weird one. This map, keeps a dependent Promise alive if the child Promise is still alive.
// A PromiseNode/AwaitNode cannot hold a strong reference to its own Promise because then it'll never get
// GC:ed. We only need it if a dependent AwaitNode points to it. We could put a reference in the Node
// but that would require a GC pass between every Node that gets destroyed. I.e. the root gets destroy()
// called on it and then that release it from the pendingOperations map which allows the next one to GC
// and so on. By putting this relationship in a WeakMap this could be done as a single pass in the VM.
// We don't actually ever have to read from this map since we have WeakRef reference to these Promises
// if they're still alive. It's also optional information so we could just expose only if GC didn't run.
const awaitedPromise: WeakMap<Promise<any>, Promise<any>> = __DEV__ &&
enableAsyncDebugInfo
  ? new WeakMap()
  : (null: any);
const previousPromise: WeakMap<Promise<any>, Promise<any>> = __DEV__ &&
enableAsyncDebugInfo
  ? new WeakMap()
  : (null: any);

// Keep the last resolved await as a workaround for async functions missing data.
let lastRanAwait: null | AwaitNode = null;

function resolvePromiseOrAwaitNode(
  unresolvedNode: UnresolvedAwaitNode | UnresolvedPromiseNode,
  endTime: number,
): AwaitNode | PromiseNode {
  const resolvedNode: AwaitNode | PromiseNode = (unresolvedNode: any);
  resolvedNode.tag = ((unresolvedNode.tag === UNRESOLVED_PROMISE_NODE
    ? PROMISE_NODE
    : AWAIT_NODE): any);
  resolvedNode.end = endTime;
  return resolvedNode;
}

const emptyStack: ReactStackTrace = [];

// Initialize the tracing of async operations.
// We do this globally since the async work can potentially eagerly
// start before the first request and once requests start they can interleave.
// In theory we could enable and disable using a ref count of active requests
// but given that typically this is just a live server, it doesn't really matter.
export function initAsyncDebugInfo(): void {
  if (__DEV__ && enableAsyncDebugInfo) {
    createHook({
      init(
        asyncId: number,
        type: string,
        triggerAsyncId: number,
        resource: any,
      ): void {
        const trigger = pendingOperations.get(triggerAsyncId);
        let node: AsyncSequence;
        if (type === 'PROMISE') {
          if (trigger !== undefined && trigger.promise !== null) {
            const triggerPromise = trigger.promise.deref();
            if (triggerPromise !== undefined) {
              // Keep the awaited Promise alive as long as the child is alive so we can
              // trace its value at the end.
              awaitedPromise.set(resource, triggerPromise);
            }
          }
          const currentAsyncId = executionAsyncId();
          if (currentAsyncId !== triggerAsyncId) {
            // When you call .then() on a native Promise, or await/Promise.all() a thenable,
            // then this intermediate Promise is created. We use this as our await point
            if (trigger === undefined) {
              // We don't track awaits on things that started outside our tracked scope.
              return;
            }
            const current = pendingOperations.get(currentAsyncId);
            if (current !== undefined && current.promise !== null) {
              const currentPromise = current.promise.deref();
              if (currentPromise !== undefined) {
                // Keep the previous Promise alive as long as the child is alive so we can
                // trace its value at the end.
                previousPromise.set(resource, currentPromise);
              }
            }
            // If the thing we're waiting on is another Await we still track that sequence
            // so that we can later pick the best stack trace in user space.
            let stack = null;
            if (
              trigger.stack !== null &&
              (trigger.tag === AWAIT_NODE ||
                trigger.tag === UNRESOLVED_AWAIT_NODE)
            ) {
              // We already had a stack for an await. In a chain of awaits we'll only need one good stack.
              // We mark it with an empty stack to signal to any await on this await that we have a stack.
              stack = emptyStack;
            } else {
              const request = resolveRequest();
              if (request === null) {
                // We don't collect stacks for awaits that weren't in the scope of a specific render.
              } else {
                stack = parseStackTrace(new Error(), 5);
                if (!isAwaitInUserspace(request, stack)) {
                  // If this await was not done directly in user space, then clear the stack. We won't use it
                  // anyway. This lets future awaits on this await know that we still need to get their stacks
                  // until we find one in user space.
                  stack = null;
                }
              }
            }
            node = ({
              tag: UNRESOLVED_AWAIT_NODE,
              owner: resolveOwner(),
              stack: stack,
              start: performance.now(),
              end: -1.1, // set when resolved.
              promise: new WeakRef((resource: Promise<any>)),
              awaited: trigger, // The thing we're awaiting on. Might get overrriden when we resolve.
              previous: current === undefined ? null : current, // The path that led us here.
            }: UnresolvedAwaitNode);
          } else {
            const owner = resolveOwner();
            node = ({
              tag: UNRESOLVED_PROMISE_NODE,
              owner: owner,
              stack: owner === null ? null : parseStackTrace(new Error(), 5),
              start: performance.now(),
              end: -1.1, // Set when we resolve.
              promise: new WeakRef((resource: Promise<any>)),
              awaited:
                trigger === undefined
                  ? null // It might get overridden when we resolve.
                  : trigger,
              previous: null,
            }: UnresolvedPromiseNode);
          }
        } else if (
          type !== 'Microtask' &&
          type !== 'TickObject' &&
          type !== 'Immediate'
        ) {
          if (trigger === undefined) {
            // We have begun a new I/O sequence.
            const owner = resolveOwner();
            node = ({
              tag: IO_NODE,
              owner: owner,
              stack: owner === null ? parseStackTrace(new Error(), 3) : null,
              start: performance.now(),
              end: -1.1, // Only set when pinged.
              promise: null,
              awaited: null,
              previous: null,
            }: IONode);
          } else if (
            trigger.tag === AWAIT_NODE ||
            trigger.tag === UNRESOLVED_AWAIT_NODE
          ) {
            // We have begun a new I/O sequence after the await.
            const owner = resolveOwner();
            node = ({
              tag: IO_NODE,
              owner: owner,
              stack: owner === null ? parseStackTrace(new Error(), 3) : null,
              start: performance.now(),
              end: -1.1, // Only set when pinged.
              promise: null,
              awaited: null,
              previous: trigger,
            }: IONode);
          } else {
            // Otherwise, this is just a continuation of the same I/O sequence.
            node = trigger;
          }
        } else {
          // Ignore nextTick and microtasks as they're not considered I/O operations.
          // we just treat the trigger as the node to carry along the sequence.
          if (trigger === undefined) {
            return;
          }
          node = trigger;
        }
        pendingOperations.set(asyncId, node);
      },
      before(asyncId: number): void {
        const node = pendingOperations.get(asyncId);
        if (node !== undefined) {
          switch (node.tag) {
            case IO_NODE: {
              lastRanAwait = null;
              // Log the end time when we resolved the I/O. This can happen
              // more than once if it's a recurring resource like a connection.
              const ioNode: IONode = (node: any);
              ioNode.end = performance.now();
              break;
            }
            case UNRESOLVED_AWAIT_NODE: {
              // If we begin before we resolve, that means that this is actually already resolved but
              // the promiseResolve hook is called at the end of the execution. So we track the time
              // in the before call instead.
              // $FlowFixMe
              lastRanAwait = resolvePromiseOrAwaitNode(node, performance.now());
              break;
            }
            case AWAIT_NODE: {
              lastRanAwait = node;
              break;
            }
            case UNRESOLVED_PROMISE_NODE: {
              // We typically don't expected Promises to have an execution scope since only the awaits
              // have a then() callback. However, this can happen for native async functions. The last
              // piece of code that executes the return after the last await has the execution context
              // of the Promise.
              const resolvedNode = resolvePromiseOrAwaitNode(
                node,
                performance.now(),
              );
              // We are missing information about what this was unblocked by but we can guess that it
              // was whatever await we ran last since this will continue in a microtask after that.
              // This is not perfect because there could potentially be other microtasks getting in
              // between.
              resolvedNode.previous = lastRanAwait;
              lastRanAwait = null;
              break;
            }
            default: {
              lastRanAwait = null;
            }
          }
        }
      },

      promiseResolve(asyncId: number): void {
        const node = pendingOperations.get(asyncId);
        if (node !== undefined) {
          let resolvedNode: AwaitNode | PromiseNode;
          switch (node.tag) {
            case UNRESOLVED_AWAIT_NODE:
            case UNRESOLVED_PROMISE_NODE: {
              resolvedNode = resolvePromiseOrAwaitNode(node, performance.now());
              break;
            }
            case AWAIT_NODE:
            case PROMISE_NODE: {
              // We already resolved this in the before hook.
              resolvedNode = node;
              break;
            }
            default:
              // eslint-disable-next-line react-internal/prod-error-codes
              throw new Error(
                'A Promise should never be an IO_NODE. This is a bug in React.',
              );
          }
          const currentAsyncId = executionAsyncId();
          if (asyncId !== currentAsyncId) {
            // If the promise was not resolved by itself, then that means that
            // the trigger that we originally stored wasn't actually the dependency.
            // Instead, the current execution context is what ultimately unblocked it.
            const awaited = pendingOperations.get(currentAsyncId);
            if (resolvedNode.tag === PROMISE_NODE) {
              // For a Promise we just override the await. We're not interested in
              // what created the Promise itself.
              resolvedNode.awaited = awaited === undefined ? null : awaited;
            } else {
              // For an await, there's really two things awaited here. It's the trigger
              // that .then() was called on but there seems to also be something else
              // in the .then() callback that blocked the returned Promise from resolving
              // immediately. We create a fork node which essentially represents an await
              // of the Promise returned from the .then() callback. That Promise was blocked
              // on the original awaited thing which we stored as "previous".
              if (awaited !== undefined) {
                const clonedNode: AwaitNode = {
                  tag: AWAIT_NODE,
                  owner: resolvedNode.owner,
                  stack: resolvedNode.stack,
                  start: resolvedNode.start,
                  end: resolvedNode.end,
                  promise: resolvedNode.promise,
                  awaited: resolvedNode.awaited,
                  previous: resolvedNode.previous,
                };
                // We started awaiting on the callback when the original .then() resolved.
                resolvedNode.start = resolvedNode.end;
                // It resolved now. We could use the end time of "awaited" maybe.
                resolvedNode.end = performance.now();
                resolvedNode.previous = clonedNode;
                resolvedNode.awaited = awaited;
              }
            }
          }
        }
      },

      destroy(asyncId: number): void {
        // If we needed the meta data from this operation we should have already
        // extracted it or it should be part of a chain of triggers.
        pendingOperations.delete(asyncId);
      },
    }).enable();
  }
}

export function markAsyncSequenceRootTask(): void {
  if (__DEV__ && enableAsyncDebugInfo) {
    // Whatever Task we're running now is spawned by React itself to perform render work.
    // Don't track any cause beyond this task. We may still track I/O that was started outside
    // React but just not the cause of entering the render.
    pendingOperations.delete(executionAsyncId());
  }
}

export function getCurrentAsyncSequence(): null | AsyncSequence {
  if (!__DEV__ || !enableAsyncDebugInfo) {
    return null;
  }
  const currentNode = pendingOperations.get(executionAsyncId());
  if (currentNode === undefined) {
    // Nothing that we tracked led to the resolution of this execution context.
    return null;
  }
  return currentNode;
}

export function getAsyncSequenceFromPromise(
  promise: any,
): null | AsyncSequence {
  if (!__DEV__ || !enableAsyncDebugInfo) {
    return null;
  }
  // A Promise is conceptually an AsyncResource but doesn't have its own methods.
  // We use this hack to extract the internal asyncId off the Promise.
  let asyncId: void | number;
  try {
    asyncId = getAsyncId.call(promise);
  } catch (x) {
    // Ignore errors extracting the ID. We treat it as missing.
    // This could happen if our hack stops working or in the case where this is
    // a Proxy that throws such as our own ClientReference proxies.
  }
  if (asyncId === undefined) {
    return null;
  }
  const node = pendingOperations.get(asyncId);
  if (node === undefined) {
    return null;
  }
  return node;
}
