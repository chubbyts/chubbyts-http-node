/* oxlint-disable functional/immutable-data */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { Readable, Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, test, vi } from 'vitest';
import { useFunctionMock } from '@chubbyts/chubbyts-function-mock/dist/function-mock';
import type { ObjectMocks } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import { useObjectMock } from '@chubbyts/chubbyts-function-mock/dist/object-mock';
import type { Body, Response, Uri } from '@chubbyts/chubbyts-http-types/message';
import type { ServerRequestFactory, UriFactory } from '@chubbyts/chubbyts-http-types/message-factory';
import type { RequestHelpers } from '@chubbyts/chubbyts-http-types/message-helper';
import {
  createNodeRequestToServerRequestFactory,
  createResponseToNodeResponseEmitter,
  getUrl,
} from '../../src/node.js';

type Listener = (...args: Array<unknown>) => void;

const createSocket = (socket: { localAddress?: string; localPort?: number; encrypted?: boolean }) =>
  socket as TLSSocket;

const createResponse = (overrides: Partial<Response> = {}): Response => ({
  status: 200,
  reasonPhrase: 'OK',
  protocolVersion: '1.1',
  headers: {},
  body: Readable.from([], { objectMode: false }),
  ...overrides,
});

// writeHead is overloaded, its parameters cannot be inferred for the mock
const createWriteHead = (
  expectedStatusCode: number,
  expectedReasonPhrase: string,
  expectedHeaders: OutgoingHttpHeaders,
  error: Error | undefined = undefined,
) =>
  ((statusCode: number, reasonPhrase: string, headers: OutgoingHttpHeaders): ServerResponse => {
    expect(statusCode).toBe(expectedStatusCode);
    expect(reasonPhrase).toBe(expectedReasonPhrase);
    expect(headers).toEqual(expectedHeaders);

    if (error) {
      throw error;
    }

    // the emitter does not use the returned response
    return undefined as unknown as ServerResponse;
  }) as ServerResponse['writeHead'];

// a writable as response: like a ServerResponse, it does not get destroyed once finished, but gets closed
const createStreamNodeResponse = (writeHead: ServerResponse['writeHead']) => {
  const chunks: Array<Buffer> = [];

  const nodeResponse = new Writable({
    autoDestroy: false,
    write: (chunk: Buffer, _encoding, callback) => {
      chunks.push(chunk);
      callback();
    },
  });

  nodeResponse.once('finish', () => nodeResponse.emit('close'));

  const closed = new Promise<void>((resolve) => nodeResponse.once('close', () => resolve()));

  return { nodeResponse: Object.assign(nodeResponse, { writeHead }) as unknown as ServerResponse, chunks, closed };
};

const uri: Uri = {
  scheme: 'https',
  userInfo: '',
  host: 'example.com',
  port: undefined,
  path: '/path/to/route',
  query: '',
  fragment: '',
};

// the implementation (factories and helpers) gets injected: mocked by a minimal one, which verifies the calls
const useImplementationMocks = (
  expected:
    | {
        url: string;
        method: string;
        protocolVersion: string;
        headers?: Array<[string, Array<string>]>;
        withBody?: boolean;
      }
    | undefined = undefined,
) => {
  const [uriFactory, uriFactoryMocks] = useFunctionMock<UriFactory>(
    expected ? [{ parameters: [expected.url], return: uri }] : [],
  );

  const [serverRequestFactory, serverRequestFactoryMocks] = useFunctionMock<ServerRequestFactory>(
    expected
      ? [
          {
            parameters: [expected.method, uri],
            return: {
              method: expected.method,
              uri,
              protocolVersion: '1.1',
              headers: {},
              body: Readable.from([]),
              signal: new AbortController().signal,
              attributes: {},
            },
          },
        ]
      : [],
  );

  const [requestHelpers, requestHelpersMocks] = useObjectMock<RequestHelpers>(
    expected
      ? [
          {
            name: 'withProtocolVersion',
            callback: (message, protocolVersion) => {
              expect(protocolVersion).toBe(expected.protocolVersion);

              return { ...message, protocolVersion };
            },
          },
          { name: 'withSignal', callback: (request, signal) => ({ ...request, signal }) },
          ...(expected.headers ?? []).map(([expectedName, expectedValues]): ObjectMocks<RequestHelpers>[number] => ({
            name: 'withHeader',
            callback: (message, name, value) => {
              expect(name).toBe(expectedName);
              expect(value).toEqual(expectedValues);

              return { ...message, headers: { ...message.headers, [name]: value as ReadonlyArray<string> } };
            },
          })),
          ...(expected.withBody
            ? [
                {
                  name: 'withBody',
                  callback: (message, body) => ({ ...message, body }),
                } satisfies ObjectMocks<RequestHelpers>[number],
              ]
            : []),
        ]
      : [],
  );

  return {
    uriFactory,
    serverRequestFactory,
    requestHelpers,
    mocks: [uriFactoryMocks, serverRequestFactoryMocks, requestHelpersMocks],
  };
};

const expectAllMocksCalled = (mocks: ReadonlyArray<ReadonlyArray<unknown>>) => {
  mocks.forEach((mock) => expect(mock).toHaveLength(0));
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// a real stream as request: the limited body gets piped from it
const createStreamNodeRequest = (body: Readable, rawHeaders: Array<string> = []): IncomingMessage =>
  Object.assign(body, {
    method: 'POST',
    rawHeaders,
    url: '/path/to/route',
    httpVersion: '1.1',
  }) as unknown as IncomingMessage;

// a stream request with a request body max bytes of 4, the implementation mocks verify the calls
const createLimitedServerRequest = (nodeRequest: IncomingMessage) => {
  const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
    { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
  ]);

  const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
    url: 'https://example.com/path/to/route',
    method: 'POST',
    protocolVersion: '1.1',
    withBody: true,
  });

  const serverRequest = createNodeRequestToServerRequestFactory(
    uriFactory,
    serverRequestFactory,
    requestHelpers,
    'https://example.com',
    undefined,
    4,
  )(nodeRequest, nodeResponse);

  return { serverRequest, mocks: [nodeResponseMocks, ...mocks] };
};

describe('node', () => {
  describe('getUrl', () => {
    test('with base url', () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([{ name: 'url', value: undefined }]);

      expect(getUrl(nodeRequest, 'https://example.com')).toMatchInlineSnapshot('"https://example.com/"');

      expect(nodeRequestMocks).toHaveLength(0);
    });

    test.each([
      ['https://example.com/', 'https://example.com/path/to/route'],
      ['https://example.com/app', 'https://example.com/app/path/to/route'],
      ['https://example.com/app/', 'https://example.com/app/path/to/route'],
    ])('with base url "%s"', (baseUrl, expected) => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'url', value: '/path/to/route' },
      ]);

      expect(getUrl(nodeRequest, baseUrl)).toBe(expected);

      expect(nodeRequestMocks).toHaveLength(0);
    });

    test.each([
      [{ localAddress: '192.168.1.5', localPort: 8443, encrypted: true }, 'https://192.168.1.5:8443/path/to/route'],
      [{ localAddress: '127.0.0.1', localPort: 443, encrypted: true }, 'https://127.0.0.1/path/to/route'],
      [{ encrypted: true }, 'https://127.0.0.1/path/to/route'],
      [{ localAddress: '192.168.1.5', localPort: 8080 }, 'http://192.168.1.5:8080/path/to/route'],
      [{ localAddress: '192.168.1.5', localPort: 8080, encrypted: false }, 'http://192.168.1.5:8080/path/to/route'],
      [{ localAddress: '127.0.0.1', localPort: 80 }, 'http://127.0.0.1/path/to/route'],
      [{}, 'http://127.0.0.1/path/to/route'],
      [{ localAddress: '::1', localPort: 8080 }, 'http://[::1]:8080/path/to/route'],
    ])('without base url, with socket %j', (socket, expected) => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'url', value: '/path/to/route' },
        { name: 'socket', value: createSocket(socket) },
      ]);

      expect(getUrl(nodeRequest)).toBe(expected);

      expect(nodeRequestMocks).toHaveLength(0);
    });

    test.each([
      [
        '//evil.com/path/to/route',
        'Request target "//evil.com/path/to/route" resolves to origin "https://evil.com" instead of the expected origin "https://example.com"',
      ],
      [
        '/\\evil.com/path/to/route',
        'Request target "/\\evil.com/path/to/route" resolves to origin "https://evil.com" instead of the expected origin "https://example.com"',
      ],
      [
        'http://evil.com/path/to/route',
        'Unsupported request target "http://evil.com/path/to/route": only origin-form (starting with "/") is supported',
      ],
      ['evil.com:443', 'Unsupported request target "evil.com:443": only origin-form (starting with "/") is supported'],
      ['*', 'Unsupported request target "*": only origin-form (starting with "/") is supported'],
    ])('with base url, with request target "%s"', (url, expected) => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([{ name: 'url', value: url }]);

      expect(() => getUrl(nodeRequest, 'https://example.com')).toThrow(expected);

      expect(nodeRequestMocks).toHaveLength(0);
    });
  });

  describe('createNodeRequestToServerRequestFactory', () => {
    test('without method', () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([{ name: 'method', value: undefined }]);
      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks();

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      expect(() => nodeRequestToServerRequestFactory(nodeRequest, nodeResponse)).toThrow('Request method is missing');

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with method, without base url', async () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'GET' },
        { name: 'rawHeaders', value: [] },
        { name: 'url', value: '/path/to/route?key=value' },
        { name: 'socket', value: createSocket({ localAddress: '192.168.1.5', localPort: 443, encrypted: true }) },
        { name: 'httpVersion', value: '1.1' },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        {
          name: 'on',
          callback: ((event: string) => {
            expect(event).toBe('close');

            return nodeResponse;
          }) as ServerResponse['on'],
        },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://192.168.1.5/path/to/route?key=value',
        method: 'GET',
        protocolVersion: '1.1',
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
      );

      const serverRequest = nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      expect(serverRequest.method).toBe('GET');
      expect(serverRequest.uri).toBe(uri);
      expect(serverRequest.protocolVersion).toBe('1.1');
      expect(serverRequest.headers).toEqual({});
      expect(serverRequest.attributes).toEqual({});
      expect(serverRequest.signal.aborted).toBe(false);

      // the body of a GET request gets ignored: the (empty) body of the factory is kept
      expect(await text(serverRequest.body)).toBe('');

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with method, with base url', () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'HEAD' },
        {
          name: 'rawHeaders',
          value: [
            'Content-Type',
            'text/plain',
            'x-custom',
            'value1',
            'X-Custom',
            'value2',
            'Cookie',
            'sessionId=abc123',
            'Cookie',
            'ui_lang=en-US',
            'Authorization',
            'Bearer token1',
          ],
        },
        { name: 'url', value: '/path/to/route' },
        { name: 'httpVersion', value: '1.0' },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      // grouped by the lowercased name, in the order of the first occurrence
      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'HEAD',
        protocolVersion: '1.0',
        headers: [
          ['content-type', ['text/plain']],
          ['x-custom', ['value1', 'value2']],
          ['cookie', ['sessionId=abc123', 'ui_lang=en-US']],
          ['authorization', ['Bearer token1']],
        ],
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      const serverRequest = nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      expect(serverRequest.method).toBe('HEAD');
      expect(serverRequest.protocolVersion).toBe('1.0');
      expect(serverRequest.headers).toMatchInlineSnapshot(`
        {
          "authorization": [
            "Bearer token1",
          ],
          "content-type": [
            "text/plain",
          ],
          "cookie": [
            "sessionId=abc123",
            "ui_lang=en-US",
          ],
          "x-custom": [
            "value1",
            "value2",
          ],
        }
      `);

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with http/2', () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'GET' },
        {
          name: 'rawHeaders',
          value: [':method', 'GET', ':path', '/', ':authority', 'evil.com', ':scheme', 'http', 'x-custom', 'value1'],
        },
        { name: 'url', value: '/' },
        { name: 'httpVersion', value: '2.0' },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      // the pseudo-headers are skipped
      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/',
        method: 'GET',
        protocolVersion: '2',
        headers: [['x-custom', ['value1']]],
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      const serverRequest = nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      expect(serverRequest.protocolVersion).toBe('2');
      expect(serverRequest.headers).toEqual({ 'x-custom': ['value1'] });

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test.each(['authorization', 'proxy-authorization'])('with multiple %s headers', (name) => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'GET' },
        { name: 'rawHeaders', value: [name, 'Basic dXNlcjE=', name.toUpperCase(), 'Basic dXNlcjI='] },
      ]);
      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks();

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      expect(() => nodeRequestToServerRequestFactory(nodeRequest, nodeResponse)).toThrow(
        `Request contains multiple "${name}" headers`,
      );

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with absolute-form request target', () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'GET' },
        { name: 'rawHeaders', value: [] },
        { name: 'url', value: 'http://evil.com/path/to/route' },
      ]);
      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks();

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      expect(() => nodeRequestToServerRequestFactory(nodeRequest, nodeResponse)).toThrow(
        'Unsupported request target "http://evil.com/path/to/route": only origin-form (starting with "/") is supported',
      );

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test.each([
      [false, true],
      [true, false],
    ])('with response closed, with writableFinished %s', (writableFinished, aborted) => {
      const closeListeners: Array<Listener> = [];

      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'GET' },
        { name: 'rawHeaders', value: [] },
        { name: 'url', value: '/' },
        { name: 'httpVersion', value: '1.1' },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        {
          name: 'on',
          callback: ((event: string, listener: Listener) => {
            expect(event).toBe('close');

            closeListeners.push(listener);

            return nodeResponse;
          }) as ServerResponse['on'],
        },
        { name: 'writableFinished', value: writableFinished },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/',
        method: 'GET',
        protocolVersion: '1.1',
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      const serverRequest = nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      expect(serverRequest.signal.aborted).toBe(false);

      closeListeners.forEach((listener) => listener());

      expect(serverRequest.signal.aborted).toBe(aborted);

      if (aborted) {
        expect((serverRequest.signal.reason as Error).name).toBe('AbortError');
      }

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, without request body timeout', async () => {
      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'POST' },
        { name: 'rawHeaders', value: ['content-type', 'application/json'] },
        { name: 'url', value: '/path/to/route' },
        { name: 'httpVersion', value: '1.1' },
        {
          name: 'on',
          callback: ((event: string, listener: Listener) => {
            expect(event).toBe('error');

            // the guard swallows the error instead of letting it surface as an unhandled 'error' event
            expect(listener(new Error('client aborted'))).toBeUndefined();

            return nodeRequest;
          }) as IncomingMessage['on'],
        },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        headers: [['content-type', ['application/json']]],
        withBody: true,
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
      );

      const serverRequest = nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      expect(serverRequest.method).toBe('POST');

      // an IncomingMessage already is a body
      expect(serverRequest.body).toBe(nodeRequest);

      // no request body timeout is configured: no timer may destroy the request afterwards (a destroy call would
      // fail with a missing mock)
      await wait(50);

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body timeout, with stalling request', async () => {
      const destroyed = Promise.withResolvers<Error>();

      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'POST' },
        { name: 'rawHeaders', value: [] },
        { name: 'url', value: '/path/to/route' },
        { name: 'httpVersion', value: '1.1' },
        { name: 'on', callback: (() => nodeRequest) as IncomingMessage['on'] },
        {
          name: 'on',
          callback: ((event: string) => {
            expect(event).toBe('close');

            return nodeRequest;
          }) as IncomingMessage['on'],
        },
        {
          name: 'destroy',
          callback: (error?: Error): IncomingMessage => {
            destroyed.resolve(error as Error);

            return nodeRequest;
          },
        },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        withBody: true,
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
        50,
      );

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      // the timeout must not keep the process alive
      expect((setTimeoutSpy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();

      expect((await destroyed.promise).message).toBe('Request body has not been fully received within 50ms');

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body timeout, with body received in time', async () => {
      const closeListeners: Array<Listener> = [];

      const [nodeRequest, nodeRequestMocks] = useObjectMock<IncomingMessage>([
        { name: 'method', value: 'POST' },
        { name: 'rawHeaders', value: [] },
        { name: 'url', value: '/path/to/route' },
        { name: 'httpVersion', value: '1.1' },
        { name: 'on', callback: (() => nodeRequest) as IncomingMessage['on'] },
        {
          name: 'on',
          callback: ((event: string, listener: Listener) => {
            expect(event).toBe('close');

            closeListeners.push(listener);

            return nodeRequest;
          }) as IncomingMessage['on'],
        },
      ]);

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        withBody: true,
      });

      const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
        50,
      );

      nodeRequestToServerRequestFactory(nodeRequest, nodeResponse);

      // the body has been fully received: the timeout gets cleared and must not destroy the request (a destroy call
      // would fail with a missing mock)
      closeListeners.forEach((listener) => listener());

      await wait(100);

      expect(nodeRequestMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });
    test.each([
      [['ab', 'cd'], []],
      [
        ['ab', 'cd'],
        ['content-length', '4'],
      ],
    ])(
      'with body, with request body max bytes, with body %j within the limit, with headers %j',
      async (chunks, rawHeaders) => {
        const nodeRequest = createStreamNodeRequest(
          Readable.from(chunks.map((chunk) => Buffer.from(chunk))),
          rawHeaders,
        );

        const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
          { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
        ]);

        const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
          url: 'https://example.com/path/to/route',
          method: 'POST',
          protocolVersion: '1.1',
          headers: rawHeaders.length > 0 ? [['content-length', ['4']]] : [],
          withBody: true,
        });

        const serverRequest = createNodeRequestToServerRequestFactory(
          uriFactory,
          serverRequestFactory,
          requestHelpers,
          'https://example.com',
          undefined,
          4,
        )(nodeRequest, nodeResponse);

        expect(serverRequest.body).not.toBe(nodeRequest);
        expect(await text(serverRequest.body)).toBe('abcd');

        expect(nodeResponseMocks).toHaveLength(0);
        expectAllMocksCalled(mocks);
      },
    );

    test('with body, with request body max bytes of 0, with empty body', async () => {
      const nodeRequest = createStreamNodeRequest(Readable.from([]));

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        withBody: true,
      });

      const serverRequest = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
        undefined,
        0,
      )(nodeRequest, nodeResponse);

      expect(await text(serverRequest.body)).toBe('');

      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with too large received body', async () => {
      const nodeRequest = createStreamNodeRequest(Readable.from([Buffer.from('abc'), Buffer.from('de')]));

      // records the state of the limited body when the request gets destroyed (first call only)
      const state: { body?: Readable; bodyDestroyedOnDestroy?: boolean; bodyDestroyedOnNextTick?: boolean } = {};
      const destroy = nodeRequest.destroy.bind(nodeRequest);

      nodeRequest.destroy = (error?: Error) => {
        if (state.bodyDestroyedOnDestroy === undefined) {
          state.bodyDestroyedOnDestroy = state.body?.destroyed;

          // scheduled before the events of the destroyed request: runs before the listeners react to them
          process.nextTick(() => {
            state.bodyDestroyedOnNextTick = state.body?.destroyed;
          });
        }

        return destroy(error);
      };

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        withBody: true,
      });

      const serverRequest = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
        undefined,
        4,
      )(nodeRequest, nodeResponse);

      state.body = serverRequest.body as Readable;

      await expect(text(serverRequest.body)).rejects.toThrow('Request body exceeds the maximum of 4 bytes');

      // the request (and therefore the connection) got destroyed right away, before the body errored (not only by
      // the listeners afterwards): the handler cannot respond while the client is still sending, the body errored
      // right away as well (not only by the listeners reacting to the destroyed request)
      expect(nodeRequest.destroyed).toBe(true);
      expect(state).toEqual({ body: serverRequest.body, bodyDestroyedOnDestroy: false, bodyDestroyedOnNextTick: true });

      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with too large content-length', async () => {
      const chunks = { read: 0 };

      const nodeRequest = createStreamNodeRequest(
        new Readable({
          read() {
            chunks.read++;
            this.push(null);
          },
        }),
        ['content-length', '5'],
      );

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        headers: [['content-length', ['5']]],
        withBody: true,
      });

      const serverRequest = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
        undefined,
        4,
      )(nodeRequest, nodeResponse);

      // rejected before reading the body, the body is the limited body as well (same type as within the limit)
      expect(nodeRequest.destroyed).toBe(true);
      expect(serverRequest.body).not.toBe(nodeRequest);
      expect((serverRequest.body as Readable).destroyed).toBe(true);

      await expect(text(serverRequest.body)).rejects.toThrow('Request body exceeds the maximum of 4 bytes');

      expect(chunks.read).toBe(0);

      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });

    test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      'with invalid request body max bytes %s',
      (requestBodyMaxBytes) => {
        const [uriFactory, uriFactoryMocks] = useFunctionMock<UriFactory>([]);
        const [serverRequestFactory, serverRequestFactoryMocks] = useFunctionMock<ServerRequestFactory>([]);
        const [requestHelpers, requestHelpersMocks] = useObjectMock<RequestHelpers>([]);

        expect(() =>
          createNodeRequestToServerRequestFactory(
            uriFactory,
            serverRequestFactory,
            requestHelpers,
            'https://example.com',
            undefined,
            requestBodyMaxBytes,
          ),
        ).toThrow(`Request body max bytes "${requestBodyMaxBytes}" must be a non-negative safe integer`);

        expect(uriFactoryMocks).toHaveLength(0);
        expect(serverRequestFactoryMocks).toHaveLength(0);
        expect(requestHelpersMocks).toHaveLength(0);
      },
    );

    test('with body, with request body max bytes, with request body timeout, with stalling request', async () => {
      const nodeRequest = createStreamNodeRequest(new Readable({ read: () => {} }));

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'on', callback: (() => nodeResponse) as ServerResponse['on'] },
      ]);

      const { uriFactory, serverRequestFactory, requestHelpers, mocks } = useImplementationMocks({
        url: 'https://example.com/path/to/route',
        method: 'POST',
        protocolVersion: '1.1',
        withBody: true,
      });

      const serverRequest = createNodeRequestToServerRequestFactory(
        uriFactory,
        serverRequestFactory,
        requestHelpers,
        'https://example.com',
        10,
        4,
      )(nodeRequest, nodeResponse);

      // the destroyed request destroys the limited body
      await expect(text(serverRequest.body)).rejects.toThrow('Request body has not been fully received within 10ms');

      expect(nodeResponseMocks).toHaveLength(0);
      expectAllMocksCalled(mocks);
    });
    test('with body, with request body max bytes, without pipeline', async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      const nodeRequest = createStreamNodeRequest(Readable.from([Buffer.from('abcd')]));

      const { serverRequest, mocks } = createLimitedServerRequest(nodeRequest);

      expect(await text(serverRequest.body)).toBe('abcd');

      await wait(0);

      // pipeline would abort its internal AbortController, even on success (a DOMException with a stack trace)
      expect(abortSpy).not.toHaveBeenCalled();

      abortSpy.mockRestore();

      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with request closed before it ended', async () => {
      const nodeRequest = createStreamNodeRequest(new Readable({ read: () => {} }));

      const { serverRequest, mocks } = createLimitedServerRequest(nodeRequest);

      // destroyed without an error: still not a complete body
      nodeRequest.destroy();

      await expect(text(serverRequest.body)).rejects.toThrow('Request body has been closed before it ended');

      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with failing request, with body not iterated', async () => {
      const error = new Error('aborted');

      const nodeRequest = createStreamNodeRequest(new Readable({ read: () => {} }));

      const { serverRequest, mocks } = createLimitedServerRequest(nodeRequest);

      nodeRequest.destroy(error);

      await wait(0);

      // the error of the not iterated body must not surface as an unhandled 'error' event
      expect((serverRequest.body as Readable).errored).toBe(error);

      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with body read after the request ended', async () => {
      const nodeRequest = createStreamNodeRequest(Readable.from([Buffer.from('ab'), Buffer.from('cd')]));

      const { serverRequest, mocks } = createLimitedServerRequest(nodeRequest);

      // the request ended (and closed) before the handler reads the body: the body is still complete
      await wait(10);

      expect(nodeRequest.readableEnded).toBe(true);
      expect(await text(serverRequest.body)).toBe('abcd');

      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with body no longer read', async () => {
      const nodeRequest = createStreamNodeRequest(new Readable({ read: () => {} }));
      nodeRequest.push('ab');

      const { serverRequest, mocks } = createLimitedServerRequest(nodeRequest);

      // oxlint-disable-next-line no-unreachable-loop
      for await (const chunk of serverRequest.body) {
        expect(Buffer.from(chunk).toString()).toBe('ab');

        break;
      }

      await wait(0);

      // the handler stopped reading the body: the request (and therefore the connection) gets destroyed
      expect(nodeRequest.destroyed).toBe(true);
      expect(nodeRequest.errored).toBeNull();

      expectAllMocksCalled(mocks);
    });

    test('with body, with request body max bytes, with request not destroyed on end', async () => {
      // a request which does not get destroyed once ended: the read body must not destroy it either
      const nodeRequest = createStreamNodeRequest(new Readable({ read: () => {}, autoDestroy: false }));
      nodeRequest.push('abcd');
      nodeRequest.push(null);

      const { serverRequest, mocks } = createLimitedServerRequest(nodeRequest);

      expect(await text(serverRequest.body)).toBe('abcd');

      await wait(0);

      expect((serverRequest.body as Readable).destroyed).toBe(true);
      expect(nodeRequest.destroyed).toBe(false);

      expectAllMocksCalled(mocks);
    });
  });

  describe('createResponseToNodeResponseEmitter', () => {
    test('with node stream body', async () => {
      const response = createResponse({
        status: 201,
        reasonPhrase: 'Created',
        headers: {
          'x-custom': ['some-value1', 'some-value2'],
          'set-cookie': [
            'sessionId=abc123; Path=/; HttpOnly; Secure; SameSite=Lax',
            'ui_lang=en-US; Path=/; Max-Age=31536000; SameSite=Lax',
          ],
        },
        body: Readable.from([Buffer.from('some'), Buffer.from(' body')], { objectMode: false }),
      });

      const { nodeResponse, chunks, closed } = createStreamNodeResponse(
        createWriteHead(201, 'Created', {
          'x-custom': ['some-value1', 'some-value2'],
          'set-cookie': [
            'sessionId=abc123; Path=/; HttpOnly; Secure; SameSite=Lax',
            'ui_lang=en-US; Path=/; Max-Age=31536000; SameSite=Lax',
          ],
        }),
      );

      createResponseToNodeResponseEmitter()(response, nodeResponse);

      await closed;

      // the ended body (closed afterwards) must not destroy the response
      await wait(0);

      expect(Buffer.concat(chunks).toString()).toBe('some body');
      expect(nodeResponse.writableFinished).toBe(true);
      expect(nodeResponse.destroyed).toBe(false);
    });

    test('with body, without pipeline', async () => {
      const abortSpy = vi.spyOn(AbortController.prototype, 'abort');

      const { nodeResponse, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse(), nodeResponse);

      await closed;

      // pipeline would abort its internal AbortController, even on success (a DOMException with a stack trace)
      expect(abortSpy).not.toHaveBeenCalled();

      abortSpy.mockRestore();
    });

    test('with web stream body', async () => {
      const response = createResponse({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('some body'));
            controller.close();
          },
        }),
      });

      const { nodeResponse, chunks, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(response, nodeResponse);

      await closed;

      expect(Buffer.concat(chunks).toString()).toBe('some body');
      expect(nodeResponse.writableFinished).toBe(true);
    });

    test('with web stream body, with response closed before it has been sent', async () => {
      const cancelled = Promise.withResolvers<unknown>();

      const response = createResponse({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            // stays open: never closes and never enqueues again
          },
          cancel(reason) {
            cancelled.resolve(reason);
          },
        }),
      });

      const { nodeResponse, chunks } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(response, nodeResponse);

      await wait(10);

      expect(Buffer.concat(chunks).toString()).toBe('partial');

      // the client disconnected: the web stream gets cancelled even while a read is pending
      nodeResponse.destroy();

      expect(await cancelled.promise).toBeNull();
    });

    test('with async generator body', async () => {
      const response = createResponse({
        body: (async function* () {
          yield Buffer.from('some');
          yield Buffer.from(' body');
        })(),
      });

      const { nodeResponse, chunks, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      const piped = new Promise<Readable>((resolve) => nodeResponse.once('pipe', resolve));

      createResponseToNodeResponseEmitter()(response, nodeResponse);

      // not in object mode: the backpressure is based on bytes, not on the number of chunks
      expect((await piped).readableObjectMode).toBe(false);

      await closed;

      expect(Buffer.concat(chunks).toString()).toBe('some body');
      expect(nodeResponse.writableFinished).toBe(true);
    });

    test('with async generator body, with response closed before it has been sent', async () => {
      const returned = Promise.withResolvers<unknown>();
      const caught = vi.fn();

      const response = createResponse({
        body: (async function* () {
          try {
            yield Buffer.from('partial');
            // a further chunk gets requested, but is not ready before the client disconnects
            await wait(20);
            yield Buffer.from('never sent');
          } catch (error) {
            caught(error);
          } finally {
            returned.resolve(undefined);
          }
        })(),
      });

      const { nodeResponse, chunks } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(response, nodeResponse);

      await wait(10);

      nodeResponse.destroy();

      await returned.promise;

      // returned, not thrown into: the generator does not see an error
      expect(caught).not.toHaveBeenCalled();
      expect(Buffer.concat(chunks).toString()).toBe('partial');
    });

    test('with failing body', async () => {
      const error = new Error('upstream failed');

      const body = new Readable({ read() {} });
      body.push('partial');

      const { nodeResponse, chunks } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse({ body }), nodeResponse);

      await wait(0);

      body.destroy(error);

      await wait(0);

      // the client must not take the truncated body for a complete one
      expect(Buffer.concat(chunks).toString()).toBe('partial');
      expect(nodeResponse.destroyed).toBe(true);
      expect((nodeResponse as unknown as Writable).errored).toBe(error);
    });

    test('with failing body, without close', async () => {
      const error = new Error('upstream failed');

      // a body which does not get destroyed on error, therefore never closes
      const body = new Readable({ read() {}, autoDestroy: false });

      const { nodeResponse } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse({ body }), nodeResponse);

      body.emit('error', error);

      await wait(0);

      // the error itself destroys the response (and not a close of the body)
      expect(nodeResponse.destroyed).toBe(true);
      expect((nodeResponse as unknown as Writable).errored).toBe(error);
    });

    test('with body closed before it ended', async () => {
      const body = new Readable({ read() {} });
      body.push('partial');

      const { nodeResponse } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse({ body }), nodeResponse);

      await wait(0);

      // destroyed without an error: still not a complete body
      body.destroy();

      await wait(0);

      expect(nodeResponse.destroyed).toBe(true);
      expect((nodeResponse as unknown as Writable).errored?.message).toBe(
        'Response body has been closed before it ended',
      );
    });

    test('with response closed before it has been sent', async () => {
      const body = new Readable({ read() {} });
      body.push('partial');

      const { nodeResponse } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse({ body }), nodeResponse);

      await wait(0);

      // the client disconnected
      nodeResponse.destroy();

      await wait(0);

      // destroyed without an error: nothing went wrong with the body itself
      expect(body.destroyed).toBe(true);
      expect(body.errored).toBeNull();
    });

    test('with response sent, with body not destroyed on end', async () => {
      // a body which does not get destroyed once ended: the sent response must not destroy it either
      const body = new Readable({ read() {}, autoDestroy: false });
      body.push('some body');
      body.push(null);

      const { nodeResponse, chunks, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse({ body }), nodeResponse);

      await closed;

      expect(Buffer.concat(chunks).toString()).toBe('some body');
      expect(body.destroyed).toBe(false);
    });

    test('with body, with response send timeout, with stalling response', async () => {
      // stays open: never ends
      const body = new Readable({ read() {} });

      const { nodeResponse, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter(50);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      responseToNodeResponseEmitter(createResponse({ body }), nodeResponse);

      // the timeout must not keep the process alive
      expect((setTimeoutSpy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();

      await closed;

      expect((nodeResponse as unknown as Writable).errored?.message).toBe(
        'Response has not been fully sent within 50ms',
      );

      // the stalling body gets stopped as well
      expect(body.destroyed).toBe(true);
    });

    test('with body, with response send timeout, with response sent in time', async () => {
      const { nodeResponse, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter(50)(createResponse(), nodeResponse);

      await closed;

      // the response has been fully sent: the timeout gets cleared and must not destroy the response
      await wait(100);

      expect(nodeResponse.writableFinished).toBe(true);
      expect(nodeResponse.destroyed).toBe(false);
    });

    test('with already destroyed body', () => {
      const body = new Readable({ read() {} });
      body.on('error', () => {});
      body.destroy(new Error('upstream failed'));

      // nothing gets written to the response (a call would fail with a missing mock)
      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([]);

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      expect(() => responseToNodeResponseEmitter(createResponse({ body }), nodeResponse)).toThrow(
        'Response body has already been destroyed',
      );

      expect(nodeResponseMocks).toHaveLength(0);
    });

    test('with already ended body', async () => {
      const body = Readable.from([]);
      body.resume();
      await new Promise((resolve) => body.once('close', resolve));

      // an ended body gets destroyed as well (autoDestroy): it still gets sent
      expect(body.destroyed).toBe(true);
      expect(body.readableEnded).toBe(true);

      const { nodeResponse, chunks, closed } = createStreamNodeResponse(createWriteHead(200, 'OK', {}));

      createResponseToNodeResponseEmitter()(createResponse({ body }), nodeResponse);

      await closed;

      expect(chunks).toHaveLength(0);
      expect(nodeResponse.writableFinished).toBe(true);
      expect(nodeResponse.destroyed).toBe(false);
    });
    test('with node stream body, with writeHead error', () => {
      const error = new TypeError('Invalid character in header content ["x-custom"]');

      const [body, bodyMocks] = useObjectMock<{ destroy: () => void } & Body>([
        // the type check, followed by the call
        { name: 'destroy', callback: () => undefined },
        { name: 'destroy', parameters: [] },
      ]);

      const response = createResponse({ headers: { 'x-custom': ['somevalue'] }, body });

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', { 'x-custom': ['somevalue'] }, error) },
      ]);

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      expect(() => responseToNodeResponseEmitter(response, nodeResponse)).toThrow(error);

      expect(bodyMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
    });

    test('with web stream body, with writeHead error', () => {
      const error = new TypeError('Invalid character in header content ["x-custom"]');

      const [body, bodyMocks] = useObjectMock<{ destroy?: () => void; cancel: () => Promise<void> } & Body>([
        { name: 'destroy', value: undefined },
        // the type check, followed by the call
        { name: 'cancel', callback: () => Promise.resolve() },
        { name: 'cancel', parameters: [], return: Promise.resolve() },
      ]);

      const response = createResponse({ body });

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', {}, error) },
      ]);

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      expect(() => responseToNodeResponseEmitter(response, nodeResponse)).toThrow(error);

      expect(bodyMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
    });

    test('with locked web stream body, with writeHead error', async () => {
      const error = new TypeError('Invalid character in header content ["x-custom"]');

      const [body, bodyMocks] = useObjectMock<{ destroy?: () => void; cancel: () => Promise<void> } & Body>([
        { name: 'destroy', value: undefined },
        // the type check, followed by the call
        { name: 'cancel', callback: () => Promise.resolve() },
        { name: 'cancel', callback: () => Promise.reject(new TypeError('Cannot cancel a locked stream')) },
      ]);

      const response = createResponse({ body });

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', {}, error) },
      ]);

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      expect(() => responseToNodeResponseEmitter(response, nodeResponse)).toThrow(error);

      // the rejected cancel must not end up as an unhandled rejection
      await wait(0);

      expect(bodyMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
    });

    test('with async generator body, with writeHead error', () => {
      const error = new TypeError('Invalid character in header content ["x-custom"]');

      const [body, bodyMocks] = useObjectMock<{ destroy?: () => void; cancel?: () => Promise<void> } & Body>([
        { name: 'destroy', value: undefined },
        { name: 'cancel', value: undefined },
      ]);

      const response = createResponse({ body });

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', {}, error) },
      ]);

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      expect(() => responseToNodeResponseEmitter(response, nodeResponse)).toThrow(error);

      expect(bodyMocks).toHaveLength(0);
      expect(nodeResponseMocks).toHaveLength(0);
    });
  });
});
