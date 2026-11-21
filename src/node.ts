import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Body, Headers, Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';

const defaultHttpPort = 80;
const defaultHttpsPort = 443;

const noop = (): void => {};

// node fires a timeout of NaN, a negative one or one above 2^31 - 1 (TIMEOUT_MAX) after 1ms: it would destroy every
// request / response right away instead of protecting against slow clients
const maxTimeoutMs = 2 ** 31 - 1;

const validateTimeoutMs = (timeoutMs: number | undefined, name: string): void => {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs)) {
    throw new Error(`${name} "${timeoutMs}" must be an integer between 1 and ${maxTimeoutMs}`);
  }
};

// credentials are singleton fields (RFC 9110 5.5): duplicates cannot be combined, a middleware
// joining the values with ', ' (getHeaderLine) would confuse downstream auth parsing
const singletonHeaderNames = new Set(['authorization', 'proxy-authorization']);

const nodeRequestToHeaders = (nodeRequest: IncomingMessage): Record<string, Array<string>> => {
  // a plain object, as the helpers take it: own properties only (a header named 'constructor' must not resolve to the
  // prototype, one named '__proto__' must not change it)
  const headers: Record<string, Array<string>> = {};
  const { rawHeaders } = nodeRequest;

  // oxlint-disable-next-line functional/no-let
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();

    // http/2 pseudo-headers (':method', ':path', ':authority', ':scheme') are no valid header names,
    // method and target are taken from the request itself, the authority from the base url or socket
    if (name.startsWith(':')) {
      continue;
    }

    const value = rawHeaders[i + 1];
    const values = Object.hasOwn(headers, name) ? headers[name] : undefined;

    if (!values) {
      // an assignment would call the prototype setter for '__proto__', defining every header is a lot slower
      // Stryker disable next-line ConditionalExpression: defining every header results in the same, only slower
      if (name === '__proto__') {
        // oxlint-disable-next-line functional/immutable-data
        Object.defineProperty(headers, name, { value: [value], enumerable: true, writable: true, configurable: true });
      } else {
        // oxlint-disable-next-line functional/immutable-data
        headers[name] = [value];
      }

      continue;
    }

    if (singletonHeaderNames.has(name)) {
      throw new Error(`Request contains multiple "${name}" headers`);
    }

    // duplicate headers (cookie included) are kept as separate values, the helpers decide how to combine them
    // oxlint-disable-next-line functional/immutable-data
    values.push(value);
  }

  return headers;
};

const headersToNodeHeaders = (headers: Headers): OutgoingHttpHeaders => {
  // without a prototype: a header named '__proto__' is a header like any other
  const nodeHeaders: Record<string, string | Array<string>> = Object.create(null);

  for (const name of Object.keys(headers)) {
    const values = headers[name];

    // a single string value avoids cloning an array (and iterating it inside node's writeHead);
    // multiple values stay as a fresh array so node sends every value as its own header line (RFC 6265 3)
    // oxlint-disable-next-line functional/immutable-data
    nodeHeaders[name] = Array.isArray(values) && values.length === 1 ? values[0] : [...values];
  }

  return nodeHeaders;
};

type ResolvedBase = { readonly origin: string; readonly pathPrefix: string };

const maxResolvedBases = 8;

// bounded cache for getUrl without a pre-resolved base (e.g. dual-stack IPv4/IPv6 sockets):
// avoids thrashing on alternating local addresses while staying strictly bounded
const resolvedBases = new Map<string, ResolvedBase>();

const parseBase = (base: string): ResolvedBase => {
  const parsedBase = new URL(base);

  return { origin: parsedBase.origin, pathPrefix: parsedBase.pathname.replace(/\/$/, '') };
};

const resolveBase = (base: string): ResolvedBase => {
  const cached = resolvedBases.get(base);

  // Stryker disable next-line ConditionalExpression,BlockStatement: parsing it again results in the same, only slower
  if (cached) {
    return cached;
  }

  const resolvedBase = parseBase(base);

  // a full cache gets cleared: bounded, nothing a client could grow
  if (resolvedBases.size >= maxResolvedBases) {
    resolvedBases.clear();
  }

  resolvedBases.set(base, resolvedBase);

  return resolvedBase;
};

// a path the url parser keeps as it is: a single leading '/' (no other host), no dot segments ('/.', '%2e') and only
// characters it does not percent-encode (RFC 3986 unreserved, sub-delims except "'" which gets encoded within the query
// of special schemes, ':', '@', '/', '%' and a '?' starting the query)
const unchangedPathPattern = /^\/(?![/\\])[\w\-.~!$&()*+,;=:@/%]*(?:\?[\w\-.~!$&()*+,;=:@/?%]*)?$/;
const dotSegmentPattern = /\/\.|%2e/i;

const resolveUrlWithBase = (path: string, { origin, pathPrefix }: ResolvedBase): string => {
  const prefixedPath = pathPrefix + path;

  // parsing every request target is costly (several percent of a request), an opaque origin ('null') cannot be resolved
  // against: such a path gets appended to the origin as it is, resolving it would result in the same url
  if (origin !== 'null' && unchangedPathPattern.test(prefixedPath) && !dotSegmentPattern.test(prefixedPath)) {
    return origin + prefixedPath;
  }

  const url = new URL(prefixedPath, origin);

  // protocol-relative ('//evil.com/path') and backslash ('/\evil.com/path') targets resolve
  // to a different host than the base url and must not be trusted
  if (url.origin !== origin) {
    throw new Error(
      `Request target "${path}" resolves to origin "${url.origin}" instead of the expected origin "${origin}"`,
    );
  }

  // same-origin protocol-relative targets ('//user@example.com/path') keep the origin but inject userinfo
  if (url.username !== '' || url.password !== '') {
    throw new Error(`Request target "${path}" must not contain userinfo`);
  }

  return url.href;
};

const getRequestPath = (nodeRequest: IncomingMessage): string => {
  const path = nodeRequest.url ?? '/';

  // only origin-form request targets can be safely appended after a host: absolute-form
  // ('http://evil.com/path'), authority-form and asterisk-form targets would end up within
  // the authority part of the built url and allow host spoofing
  if (!path.startsWith('/')) {
    throw new Error(`Unsupported request target "${path}": only origin-form (starting with "/") is supported`);
  }

  return path;
};

const getSocketBase = (nodeRequest: IncomingMessage): string => {
  const { socket } = nodeRequest;
  const encrypted = socket !== null && socket !== undefined && 'encrypted' in socket && socket.encrypted === true;
  const schema = encrypted ? 'https' : 'http';
  // strip IPv6 zone ID (e.g. 'fe80::1%eth0') which WHATWG URL rejects
  const rawAddress = socket?.localAddress ?? '127.0.0.1';
  const address = rawAddress.includes('%') ? rawAddress.slice(0, rawAddress.indexOf('%')) : rawAddress;
  const host = address.includes(':') ? `[${address}]` : address;
  const port = socket?.localPort ?? (encrypted ? defaultHttpsPort : defaultHttpPort);

  return `${schema}://${host}:${port}`;
};

export const getUrl = (nodeRequest: IncomingMessage, baseUrl: string | undefined = undefined): string => {
  const path = getRequestPath(nodeRequest);

  // an empty base url means none: the url gets built from the local address of the socket
  return resolveUrlWithBase(path, resolveBase(baseUrl || getSocketBase(nodeRequest)));
};

// node reports HTTP/2 as '2.0', the types expect '2'
const getProtocolVersion = (nodeRequest: IncomingMessage): string => {
  const { httpVersion } = nodeRequest;

  return httpVersion === '2.0' ? '2' : httpVersion;
};

// node does not limit the body size itself: a too large body destroys the request, which closes the connection as the
// client would otherwise keep on sending the body, the error reaches the handler while iterating the body
const limitBody = (
  nodeRequest: IncomingMessage,
  contentLength: string | undefined,
  transferEncoding: string | undefined,
  requestBodyMaxBytes: number,
  readEagerly: boolean,
): Body => {
  const createError = (): Error => new Error(`Request body exceeds the maximum of ${requestBodyMaxBytes} bytes`);

  // a declared too large body gets rejected before attaching any listeners or reading the body;
  // still returns a destroyed Readable so the body type is identical regardless of how the limit got exceeded
  if (Number(contentLength) > requestBodyMaxBytes) {
    const error = createError();
    // never read: destroyed right away
    const limitedBody = new Readable();
    limitedBody.on('error', noop);

    nodeRequest.destroy(error);
    limitedBody.destroy(error);

    return limitedBody;
  }

  const state = { bytes: 0, attached: false };

  // feeds the limited body from the request: a readable fed by the request instead of a transform piped from it, a
  // transform is a readable and a writable, pipe adds and removes half a dozen listeners per request
  const attach = (): void => {
    if (state.attached) {
      return;
    }

    // oxlint-disable-next-line functional/immutable-data
    state.attached = true;

    // the request ended before its body got read: node discarded the body (it dumps the body nobody reads once the
    // response has been sent), an empty body would silently lose the data of a request that declared one
    if (nodeRequest.readableEnded) {
      if (transferEncoding !== undefined || Number(contentLength) > 0) {
        limitedBody.destroy(new Error('Request body has been discarded before it got read'));
      } else {
        // oxlint-disable-next-line functional/immutable-data
        limitedBody.push(null);
      }

      return;
    }

    // a chunked body (or one with a wrong content-length) gets limited while reading it
    nodeRequest.on('data', (chunk: Buffer) => {
      // oxlint-disable-next-line functional/immutable-data
      state.bytes += chunk.length;

      if (state.bytes > requestBodyMaxBytes) {
        const error = createError();

        // both sides get destroyed right away (the close listeners would defer it to the next ticks): the connection
        // gets closed before the handler, getting the error while iterating the body, could respond while the client is
        // still sending
        nodeRequest.destroy(error);
        limitedBody.destroy(error);

        return;
      }

      // backpressure: a limited body not read fast enough pauses the request until it gets read
      // oxlint-disable-next-line functional/immutable-data
      if (!limitedBody.push(chunk)) {
        nodeRequest.pause();
      }
    });

    // oxlint-disable-next-line functional/immutable-data
    nodeRequest.on('end', () => limitedBody.push(null));
  };

  // attached on the first read (http/1): node dumps the body of a request nobody reads once the response has been sent,
  // a handler that never reads it (e.g. 401/404) neither buffers it nor keeps the request from ending
  const limitedBody = new Readable({
    read: () => {
      attach();
      nodeRequest.resume();
    },
    // synchronously destroy the request when the handler stops reading the body, so no further chunks arrive on the
    // same tick and the client stops sending
    destroy: (error, callback) => {
      if (!nodeRequest.readableEnded && !nodeRequest.destroyed) {
        nodeRequest.destroy();
      }

      callback(error);
    },
  });

  // no unhandled 'error' event for a body nobody iterates, iterating the body still rejects with the error
  limitedBody.on('error', noop);

  // the failures get propagated by hand: a destroyed request (client abort, request body timeout) destroys the limited
  // body, the error reaches the handler while iterating the body
  nodeRequest.on('error', (error) => limitedBody.destroy(error));

  if (nodeRequest.closed) {
    if (!nodeRequest.readableEnded) {
      limitedBody.destroy(nodeRequest.errored ?? new Error('Request body has been closed before it ended'));
    }
  } else {
    nodeRequest.on('close', () => {
      if (!nodeRequest.readableEnded && !limitedBody.destroyed) {
        limitedBody.destroy(new Error('Request body has been closed before it ended'));
      }
    });
  }

  // http/2 has no dump: the unread data of a stream gets the stream reset once the response has been sent, the client
  // sending on resets the whole session (NGHTTP2_ENHANCE_YOUR_CALM), failing the other requests on it. Read right away,
  // the limited body buffers the body (and backpressure pauses the request) until the handler reads it
  if (readEagerly) {
    attach();
  }

  return limitedBody;
};

type NodeRequestToServerRequestFactory = (nodeRequest: IncomingMessage, nodeResponse: ServerResponse) => ServerRequest;

export const createNodeRequestToServerRequestFactory = (
  uriFactory: UriFactory,
  serverRequestFactory: ServerRequestFactory,
  requestHelpers: RequestHelpers,
  baseUrl: string | undefined = undefined,
  requestBodyTimeoutMs: number | undefined = undefined,
  requestBodyMaxBytes: number | undefined = undefined,
): NodeRequestToServerRequestFactory => {
  // fail fast: NaN would silently disable the limit (every comparison with it is false)
  if (requestBodyMaxBytes !== undefined && (!Number.isSafeInteger(requestBodyMaxBytes) || requestBodyMaxBytes < 0)) {
    throw new Error(`Request body max bytes "${requestBodyMaxBytes}" must be a non-negative safe integer`);
  }

  validateTimeoutMs(requestBodyTimeoutMs, 'Request body timeout ms');

  // pre-resolve the base url once per factory: fails fast on invalid base url and avoids per-request cache lookups, an
  // empty base url means none (as with getUrl): the url gets built from the local address of the socket
  const resolvedBase = baseUrl ? parseBase(baseUrl) : undefined;

  return (nodeRequest: IncomingMessage, nodeResponse: ServerResponse): ServerRequest => {
    const { method } = nodeRequest;

    // node's parser guarantees a method for every parsed request: a missing one means the
    // IncomingMessage was not produced by the parser and must not silently be treated as GET
    if (!method) {
      throw new Error('Request method is missing');
    }

    const headers = nodeRequestToHeaders(nodeRequest);

    const url = resolvedBase ? resolveUrlWithBase(getRequestPath(nodeRequest), resolvedBase) : getUrl(nodeRequest);
    const uri = uriFactory(url);

    // the request is no longer needed once the response got closed without having been fully sent:
    // the client disconnected, or the response got destroyed (e.g. by the response send timeout)
    const abortController = new AbortController();

    if (nodeResponse.closed) {
      if (!nodeResponse.writableFinished) {
        abortController.abort();
      }
    } else {
      nodeResponse.on('close', () => {
        if (!nodeResponse.writableFinished) {
          abortController.abort();
        }
      });
    }

    // created and changed through the injected implementation only: the bridge works with any of them
    const protocolVersion = getProtocolVersion(nodeRequest);

    const createdServerRequest = requestHelpers.withProtocolVersion(serverRequestFactory(method, uri), protocolVersion);

    const serverRequestWithSignal = requestHelpers.withSignal(createdServerRequest, abortController.signal);

    // withHeaders copies the request only once, withHeader once per header: optional for the implementations of 4.x
    const { withHeaders } = requestHelpers;

    const serverRequest = withHeaders
      ? (withHeaders.call(requestHelpers, serverRequestWithSignal, headers) as ServerRequest)
      : Object.entries(headers).reduce(
          (request, [name, values]) => requestHelpers.withHeader(request, name, values),
          serverRequestWithSignal,
        );

    // the body of a GET or HEAD request gets ignored: the server request keeps the (empty) body of the factory
    if (method === 'GET' || method === 'HEAD') {
      return serverRequest;
    }

    // a client abort / socket error must not surface as an unhandled 'error' event;
    // iterating the body still rejects with the error
    nodeRequest.on('error', noop);

    // slowloris protection: a client sending the body arbitrarily slow would otherwise keep the
    // request (and its socket) alive forever, the error reaches the handler while iterating the body
    if (requestBodyTimeoutMs !== undefined && !nodeRequest.closed) {
      const timeout = setTimeout(() => {
        nodeRequest.destroy(new Error(`Request body has not been fully received within ${requestBodyTimeoutMs}ms`));
      }, requestBodyTimeoutMs);
      timeout.unref();

      nodeRequest.on('close', () => clearTimeout(timeout));
    }

    if (requestBodyMaxBytes !== undefined) {
      return requestHelpers.withBody(
        serverRequest,
        limitBody(
          nodeRequest,
          headers['content-length']?.[0],
          headers['transfer-encoding']?.[0],
          requestBodyMaxBytes,
          protocolVersion === '2',
        ),
      );
    }

    // an IncomingMessage already is an AsyncIterable<Buffer>
    return requestHelpers.withBody(serverRequest, nodeRequest);
  };
};

// a not yet iterated body cannot be cancelled through its async iterator (returning an unstarted
// async generator skips its cleanup): node streams get destroyed, web streams cancelled
const cancelBody = (body: Body): void => {
  const cancellableBody = body as Partial<{ destroy: () => void; cancel: () => Promise<void> }>;

  if (typeof cancellableBody.destroy === 'function') {
    cancellableBody.destroy();
  } else if (typeof cancellableBody.cancel === 'function') {
    cancellableBody.cancel().catch(() => {});
  }
};

const toReadable = (body: Body): Readable => {
  if (body instanceof Readable) {
    return body;
  }

  // a web stream gets converted with fromWeb: iterating it, a pending read blocks the return of its async iterator and
  // the stream would not get cancelled on failure
  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as NodeReadableStream);
  }

  // not in object mode: the chunks of a body have to be bytes
  return Readable.from(body, { objectMode: false });
};

// ended: the end of the body got pushed (no chunk follows), the 'end' event comes once the buffered chunks got read
type ReadableWithState = Readable & { _readableState: { ended: boolean } };

// the body might have ended already (node < 26 emits the scheduled end of a paused body), end() fully uncorks then
const uncorkResponse = (nodeResponse: ServerResponse): void => {
  if (nodeResponse.writableCorked > 0) {
    nodeResponse.uncork();
  }
};

// written by hand instead of using pipeline or pipe: pipeline creates an AbortController per call and aborts it once
// done, even on success, the abort reason is a DOMException capturing a stack trace (about 3µs per response, which
// nobody reads), pipe adds and removes half a dozen listeners per response
const sendBody = (body: Readable, nodeResponse: ServerResponse, timeout: NodeJS.Timeout | undefined): void => {
  // a failing response (e.g. a write after it got destroyed) must not surface as an unhandled 'error' event
  nodeResponse.on('error', noop);

  // a closed response clears the send timeout (one close listener for both), a response closed before it has been
  // fully sent (client disconnected, response send timeout) stops the body, destroyed without an error: an async
  // iterator gets returned (not thrown into), a web stream cancelled
  nodeResponse.on('close', () => {
    clearTimeout(timeout);

    if (!nodeResponse.writableFinished) {
      body.destroy();
    }
  });

  // an already ended body emits no 'end' anymore: there is nothing left to send (skip body listeners)
  if (body.readableEnded) {
    nodeResponse.end();

    return;
  }

  // a failing body destroys the response: the client must not take a truncated body for a complete one
  body.on('error', (error) => nodeResponse.destroy(error));
  body.on('close', () => {
    if (!body.readableEnded && !nodeResponse.destroyed) {
      nodeResponse.destroy(new Error('Response body has been closed before it ended'));
    }
  });

  // backpressure: a response not sent fast enough pauses the body until it got drained (a drain listener only then,
  // instead of one for every response)
  body.on('data', (chunk: Buffer) => {
    // the last chunk of a body read to its end already (e.g. one created from a buffer): node sends a written chunk on
    // the next tick, the end (the terminating chunk) follows a tick later, two writes per response. Corked, end() sends
    // both at once: the same bytes within one write. A body still being read (e.g. a file) is not delayed.
    // oxlint-disable-next-line no-underscore-dangle
    const isLastChunk = body.readableLength === 0 && (body as ReadableWithState)._readableState.ended;
    if (isLastChunk) {
      nodeResponse.cork();
    }

    if (!nodeResponse.write(chunk)) {
      body.pause();
      nodeResponse.once('drain', () => body.resume());

      // a paused body might not end: a corked response would never get drained, sent on the next tick as node does
      if (isLastChunk) {
        process.nextTick(uncorkResponse, nodeResponse);
      }
    }
  });

  body.on('end', () => nodeResponse.end());

  // a 'data' listener does not resume an explicitly paused body
  body.resume();
};

const destroyNotSentResponse = (nodeResponse: ServerResponse, responseSendTimeoutMs: number): void => {
  nodeResponse.destroy(new Error(`Response has not been fully sent within ${responseSendTimeoutMs}ms`));
};

type ResponseToNodeResponseEmitter = (response: Response, nodeResponse: ServerResponse) => void;

export const createResponseToNodeResponseEmitter = (
  responseSendTimeoutMs: number | undefined = undefined,
): ResponseToNodeResponseEmitter => {
  validateTimeoutMs(responseSendTimeoutMs, 'Response send timeout ms');

  return (response: Response, nodeResponse: ServerResponse): void => {
    // a destroyed (e.g. errored) body cannot be sent anymore, sending it would destroy the connection: thrown before
    // anything has been written, the caller is still able to send an error response
    if (response.body instanceof Readable && response.body.destroyed && !response.body.readableEnded) {
      throw new Error('Response body has already been destroyed');
    }

    // a locked web stream cannot be converted with Readable.fromWeb: thrown before writeHead so headers are not
    // sent and no send timeout is leaked
    if (response.body instanceof ReadableStream && response.body.locked) {
      throw new Error('Response body is locked');
    }

    // client already disconnected before the handler returned: cancel the body without writing or starting a timer
    if (nodeResponse.closed || nodeResponse.destroyed) {
      cancelBody(response.body);

      return;
    }

    // node rejects control characters within header values and a status outside 100-999:
    // writeHead can therefore throw for a constructed Response; cancel the potentially
    // connection-backed body before surfacing the error, nothing has been sent to the client yet
    try {
      nodeResponse.writeHead(response.status, response.reasonPhrase, headersToNodeHeaders(response.headers));
    } catch (error) {
      cancelBody(response.body);

      throw error;
    }

    const body = toReadable(response.body);

    // slowloris protection: a client reading the response arbitrarily slow (or a stalling response
    // body stream) would otherwise keep the response (and its socket) alive forever
    // without a closure per response, gets cleared by the close listener of sendBody
    const timeout =
      responseSendTimeoutMs !== undefined
        ? setTimeout(destroyNotSentResponse, responseSendTimeoutMs, nodeResponse, responseSendTimeoutMs).unref()
        : undefined;

    sendBody(body, nodeResponse, timeout);
  };
};
