import { EventEmitter } from 'events';
import ow from 'ow';
import { Request as PuppeteerRequest, Page } from 'puppeteer'; // eslint-disable-line no-unused-vars
import * as _ from './underscore';

// We use weak maps here so that the content gets discarted after page gets closed.
const pageInterceptRequestHandlersMap = new WeakMap(); // Maps page to an array of request interception handlers.
const pageInterceptRequestMasterHandlerMap = new WeakMap(); // Maps page to master request interception handler.
const pageInterceptedRequestsMap = new WeakMap(); // Maps page to a set of its pending intercepted requests.

/**
 * Enables observation of changes of internal state
 * to be able to queue other actions based on it.
 * @ignore
 */
class ObservableSet extends EventEmitter {
    constructor() {
        super();
        this.set = new Set();
    }

    add(value) {
        this.set.add(value);
        this.emit('add', value);
        return this.set;
    }

    delete(value) {
        const success = this.set.delete(value);
        this.emit('delete', value);
        return success;
    }

    get size() {
        return this.set.size;
    }
}

/**
 * @callback InterceptHandler
 * @param {PuppeteerRequest} request
 */

/**
 * Makes all request headers capitalized to more look like in browser
 * @param {Object<string, string>} headers
 * @returns {Object<string, string>}
 */
const browserifyHeaders = (headers) => {
    const finalHeaders = {};
    // eslint-disable-next-line prefer-const
    for (let [key, value] of Object.entries(headers)) {
        key = key
            .toLowerCase()
            .split('-')
            .map((str) => str.charAt(0).toUpperCase() + str.slice(1))
            .join('-');

        finalHeaders[key] = value;
    }

    return finalHeaders;
};

/**
 * Executes an array for given intercept request handlers for a given request object.
 *
 * @param {PuppeteerRequest} request Puppeteer's Request object.
 * @param {Array<InterceptHandler>} interceptRequestHandlers An array of intercept request handlers.
 * @ignore
 */
const handleRequest = async (request, interceptRequestHandlers) => {
    // If there are no intercept handlers, it means that request interception is not enabled (anymore)
    // and therefore .abort() .respond() and .continue() would throw and crash the process.
    if (!interceptRequestHandlers.length) return;

    let wasAborted = false;
    let wasResponded = false;
    let wasContinued = false;
    const accumulatedOverrides = {
        headers: browserifyHeaders(request.headers()),
    };

    const originalContinue = request.continue.bind(request);
    request.continue = (overrides = {}) => {
        wasContinued = true;
        const headers = browserifyHeaders({
            ...accumulatedOverrides.headers,
            ...overrides.headers,
        });
        Object.assign(accumulatedOverrides, overrides, { headers });
    };

    request.abort = _.wrap(request.abort.bind(request), (abort, ...args) => {
        wasAborted = true;

        return abort(...args);
    });

    request.respond = _.wrap(
        request.respond.bind(request),
        (respond, ...args) => {
            wasResponded = true;

            return respond(...args);
        },
    );

    for (const handler of interceptRequestHandlers) {
        wasContinued = false;

        await handler(request);
        // Check that one of the functions was called.
        if (!wasAborted && !wasResponded && !wasContinued) {
            throw new Error(
                'Intercept request handler must call one of request.continue|respond|abort() methods!',
            );
        }

        // If request was aborted or responded then we can finish immediately.
        if (wasAborted || wasResponded) return;
    }

    return originalContinue(accumulatedOverrides);
};

/**
 * Adds request interception handler in similar to `page.on('request', handler);` but in addition to that
 * supports multiple parallel handlers.
 *
 * All the handlers are executed sequentially in the order as they were added.
 * Each of the handlers must call one of `request.continue()`, `request.abort()` and `request.respond()`.
 * In addition to that any of the handlers may modify the request object (method, postData, headers)
 * by passing its overrides to `request.continue()`.
 * If multiple handlers modify same property then the last one wins. Headers are merged separately so you can
 * override only a value of specific header.
 *
 * If one the handlers calls `request.abort()` or `request.respond()` then request is not propagated further
 * to any of the remaining handlers.
 *
 *
 * **Example usage:**
 *
 * ```javascript
 * // Replace images with placeholder.
 * await addInterceptRequestHandler(page, (request) => {
 *     if (request.resourceType() === 'image') {
 *         return request.respond({
 *             statusCode: 200,
 *             contentType: 'image/jpeg',
 *             body: placeholderImageBuffer,
 *         });
 *     }
 *     return request.continue();
 * });
 *
 * // Abort all the scripts.
 * await addInterceptRequestHandler(page, (request) => {
 *     if (request.resourceType() === 'script') return request.abort();
 *     return request.continue();
 * });
 *
 * // Change requests to post.
 * await addInterceptRequestHandler(page, (request) => {
 *     return request.continue({
 *          method: 'POST',
 *     });
 * });
 *
 * await page.goto('http://example.com');
 * ```
 *
 * @param {Page} page
 *   Puppeteer [`Page`](https://pptr.dev/#?product=Puppeteer&show=api-class-page) object.
 * @param {InterceptHandler} handler Request interception handler.
 * @return {Promise<void>}
 * @memberOf puppeteer
 * @name addInterceptRequestHandler
 */
export const addInterceptRequestHandler = async (page, handler) => {
    ow(page, ow.object.hasKeys('goto', 'evaluate'));
    ow(handler, ow.function);

    if (!pageInterceptRequestHandlersMap.has(page)) {
        pageInterceptRequestHandlersMap.set(page, []);
    }
    if (!pageInterceptedRequestsMap.has(page)) {
        pageInterceptedRequestsMap.set(page, new ObservableSet());
    }

    const handlersArray = pageInterceptRequestHandlersMap.get(page);
    handlersArray.push(handler);

    // First handler was just added at this point so we need to set up request interception.
    if (handlersArray.length === 1) {
        await page.setRequestInterception(true);

        // This is a handler that gets set in page.on('request', ...) and that executes all the user
        // added custom handlers.
        const masterHandler = async (request) => {
            const interceptedRequests = pageInterceptedRequestsMap.get(page);
            interceptedRequests.add(request);
            const interceptHandlers = pageInterceptRequestHandlersMap.get(page);
            try {
                await handleRequest(request, interceptHandlers);
            } finally {
                interceptedRequests.delete(request);
            }
        };

        pageInterceptRequestMasterHandlerMap.set(page, masterHandler);
        page.on('request', masterHandler);
    }
};

/**
 * Removes request interception handler for given page.
 *
 * @param {Page} page
 *   Puppeteer [`Page`](https://pptr.dev/#?product=Puppeteer&show=api-class-page) object.
 * @param {InterceptHandler} handler Request interception handler.
 * @return {Promise<void>}
 * @memberOf puppeteer
 * @name removeInterceptRequestHandler
 */
export const removeInterceptRequestHandler = async (page, handler) => {
    ow(page, ow.object.hasKeys('goto', 'evaluate'));
    ow(handler, ow.function);

    const handlersArray = pageInterceptRequestHandlersMap
        .get(page)
        .filter((item) => item !== handler);

    pageInterceptRequestHandlersMap.set(page, handlersArray);

    if (handlersArray.length === 0) {
        const interceptedRequestsInProgress = pageInterceptedRequestsMap.get(
            page,
        );
        // Since handlers can be async, we can't simply turn off request interception
        // when there are no handlers, because some handlers could still
        // be in progress and request.abort|respond|continue() would throw.
        if (interceptedRequestsInProgress.size === 0) {
            await disableRequestInterception(page);
        } else {
            const onDelete = () => {
                if (interceptedRequestsInProgress.size === 0) {
                    disableRequestInterception(page);
                    interceptedRequestsInProgress.removeListener(
                        'delete',
                        onDelete,
                    );
                }
            };
            interceptedRequestsInProgress.on('delete', onDelete);
        }
    }
};

async function disableRequestInterception(page) {
    await page.setRequestInterception(false);
    const requestHandler = pageInterceptRequestMasterHandlerMap.get(page);
    page.removeListener('request', requestHandler);
}
