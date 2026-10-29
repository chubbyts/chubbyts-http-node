import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Readable, pipeline } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Body, Headers, Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';

const defaultHttpPort = 80;
const defaultHttpsPort = 443;

// credentials are singleton fields (RFC 9110 5.5): duplicates cannot be combined, a middleware
// joining the values with ', ' (getHeaderLine) would confuse downstream auth parsing
const singletonHeaderNames = new Set(['authorization', 'proxy-authorization']);

const nodeRequestToHeaders = (nodeRequest: IncomingMessage): Map<string, Array<string>> => {
  // a map instead of an object: a header named '__proto__' must not change the prototype
  const headers = new Map<string, Array<string>>();
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
    const values = headers.get(name);

    if (!values) {
      headers.set(name, [value]);

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

const headersToNodeHeaders = (headers: Headers): OutgoingHttpHeaders =>
  // node sends every value of an array as its own header line, which is required for set-cookie (RFC 6265 3)
  Object.fromEntries(Object.entries(headers).map(([name, values]) => [name, [...values]]));

const resolveUrl = (path: string, base: string): string => {
  const parsedBase = new URL(base);
  const url = new URL(parsedBase.pathname.replace(/\/$/, '') + path, parsedBase.origin);

  // protocol-relative ('//evil.com/path') and backslash ('/\evil.com/path') targets resolve
  // to a different host than the base url and must not be trusted
  if (url.origin !== parsedBase.origin) {
    throw new Error(
      `Request target "${path}" resolves to origin "${url.origin}" instead of the expected origin "${parsedBase.origin}"`,
    );
  }

  return url.toString();
};

export const getUrl = (nodeRequest: IncomingMessage, baseUrl: string | undefined = undefined): string => {
  const path = nodeRequest.url ?? '/';

  // only origin-form request targets can be safely appended after a host: absolute-form
  // ('http://evil.com/path'), authority-form and asterisk-form targets would end up within
  // the authority part of the built url and allow host spoofing
  if (!path.startsWith('/')) {
    throw new Error(`Unsupported request target "${path}": only origin-form (starting with "/") is supported`);
  }

  if (baseUrl) {
    return resolveUrl(path, baseUrl);
  }

  const { socket } = nodeRequest;
  const encrypted = 'encrypted' in socket && socket.encrypted === true;
  const schema = encrypted ? 'https' : 'http';
  const address = socket.localAddress ?? '127.0.0.1';
  const host = address.includes(':') ? `[${address}]` : address;
  const port = socket.localPort ?? (encrypted ? defaultHttpsPort : defaultHttpPort);

  return resolveUrl(path, `${schema}://${host}:${port}`);
};

// node reports HTTP/2 as '2.0', the types expect '2'
const getProtocolVersion = (nodeRequest: IncomingMessage): string => {
  const { httpVersion } = nodeRequest;

  return httpVersion === '2.0' ? '2' : httpVersion;
};

type NodeRequestToServerRequestFactory = (nodeRequest: IncomingMessage, nodeResponse: ServerResponse) => ServerRequest;

export const createNodeRequestToServerRequestFactory = (
  uriFactory: UriFactory,
  serverRequestFactory: ServerRequestFactory,
  requestHelpers: RequestHelpers,
  baseUrl: string | undefined = undefined,
  requestBodyTimeoutMs: number | undefined = undefined,
): NodeRequestToServerRequestFactory => {
  return (nodeRequest: IncomingMessage, nodeResponse: ServerResponse): ServerRequest => {
    const { method } = nodeRequest;

    // node's parser guarantees a method for every parsed request: a missing one means the
    // IncomingMessage was not produced by the parser and must not silently be treated as GET
    if (!method) {
      throw new Error('Request method is missing');
    }

    const headers = nodeRequestToHeaders(nodeRequest);

    const uri = uriFactory(getUrl(nodeRequest, baseUrl));

    // the request is no longer needed once the response got closed without having been fully sent:
    // the client disconnected, or the response got destroyed (e.g. by the response send timeout)
    const abortController = new AbortController();

    nodeResponse.on('close', () => {
      if (!nodeResponse.writableFinished) {
        abortController.abort();
      }
    });

    // created and changed through the injected implementation only: the bridge works with any of them
    const createdServerRequest = requestHelpers.withProtocolVersion(
      serverRequestFactory(method, uri),
      getProtocolVersion(nodeRequest),
    );

    const serverRequest = [...headers].reduce(
      (request, [name, values]) => requestHelpers.withHeader(request, name, values),
      requestHelpers.withSignal(createdServerRequest, abortController.signal),
    );

    // the body of a GET or HEAD request gets ignored: the server request keeps the (empty) body of the factory
    if (method === 'GET' || method === 'HEAD') {
      return serverRequest;
    }

    // a client abort / socket error must not surface as an unhandled 'error' event;
    // iterating the body still rejects with the error
    nodeRequest.on('error', () => {});

    // slowloris protection: a client sending the body arbitrarily slow would otherwise keep the
    // request (and its socket) alive forever, the error reaches the handler while iterating the body
    if (requestBodyTimeoutMs !== undefined) {
      const timeout = setTimeout(() => {
        nodeRequest.destroy(new Error(`Request body has not been fully received within ${requestBodyTimeoutMs}ms`));
      }, requestBodyTimeoutMs);
      timeout.unref();

      nodeRequest.on('close', () => clearTimeout(timeout));
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

type ResponseToNodeResponseEmitter = (response: Response, nodeResponse: ServerResponse) => void;

export const createResponseToNodeResponseEmitter = (
  responseSendTimeoutMs: number | undefined = undefined,
): ResponseToNodeResponseEmitter => {
  return (response: Response, nodeResponse: ServerResponse): void => {
    // node rejects control characters within header values and a status outside 100-999:
    // writeHead can therefore throw for a constructed Response; cancel the potentially
    // connection-backed body before surfacing the error, nothing has been sent to the client yet
    try {
      nodeResponse.writeHead(response.status, response.reasonPhrase, headersToNodeHeaders(response.headers));
    } catch (error) {
      cancelBody(response.body);

      throw error;
    }

    // slowloris protection: a client reading the response arbitrarily slow (or a stalling response
    // body stream) would otherwise keep the response (and its socket) alive forever
    if (responseSendTimeoutMs !== undefined) {
      const timeout = setTimeout(() => {
        nodeResponse.destroy(new Error(`Response has not been fully sent within ${responseSendTimeoutMs}ms`));
      }, responseSendTimeoutMs);
      timeout.unref();

      nodeResponse.on('close', () => clearTimeout(timeout));
    }

    // pipeline destroys both sides itself on failure (a failing nodeResponse stops the body
    // iteration, a failing body destroys nodeResponse): the callback only consumes the error
    // a web stream gets converted: pipeline would iterate it, a pending read blocks the return of its async iterator
    // and the stream would not get cancelled on failure
    const body =
      response.body instanceof ReadableStream ? Readable.fromWeb(response.body as NodeReadableStream) : response.body;

    pipeline(body, nodeResponse, () => {});
  };
};
