/* oxlint-disable functional/immutable-data */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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

type Pipeline = (source: Body, destination: ServerResponse, callback: (error: Error | null) => void) => unknown;

type Listener = (...args: Array<unknown>) => void;

const pipelineHolder = vi.hoisted((): { pipeline?: (...args: Array<unknown>) => unknown } => ({}));

vi.mock('node:stream', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pipeline: (...args: Array<unknown>) => pipelineHolder.pipeline?.(...args),
}));

beforeEach(() => {
  pipelineHolder.pipeline = undefined;
});

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
  });

  describe('createResponseToNodeResponseEmitter', () => {
    test('with body', () => {
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
      });

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        {
          name: 'writeHead',
          callback: createWriteHead(201, 'Created', {
            'x-custom': ['some-value1', 'some-value2'],
            'set-cookie': [
              'sessionId=abc123; Path=/; HttpOnly; Secure; SameSite=Lax',
              'ui_lang=en-US; Path=/; Max-Age=31536000; SameSite=Lax',
            ],
          }),
        },
      ]);

      const [pipeline, pipelineMocks] = useFunctionMock<Pipeline>([
        {
          callback: (source, destination, callback) => {
            expect(source).toBe(response.body);
            expect(destination).toBe(nodeResponse);

            // the errors get handled by pipeline itself, the callback only consumes them
            expect(callback(new Error('write failed'))).toBeUndefined();
          },
        },
      ]);

      pipelineHolder.pipeline = pipeline as (...args: Array<unknown>) => unknown;

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      responseToNodeResponseEmitter(response, nodeResponse);

      expect(nodeResponseMocks).toHaveLength(0);
      expect(pipelineMocks).toHaveLength(0);
    });

    test('with web stream body', async () => {
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

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', {}) },
      ]);

      const [pipeline, pipelineMocks] = useFunctionMock<Pipeline>([
        {
          callback: (source) => {
            // a node stream, which cancels the web stream even while a read is pending
            expect(source).toBeInstanceOf(Readable);

            // pipeline is mocked: nothing else listens to the error of the destroyed source
            (source as Readable).on('error', () => {}).destroy(new Error('client gone'));
          },
        },
      ]);

      pipelineHolder.pipeline = pipeline as (...args: Array<unknown>) => unknown;

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter();

      responseToNodeResponseEmitter(response, nodeResponse);

      expect(((await cancelled.promise) as Error).message).toBe('client gone');

      expect(nodeResponseMocks).toHaveLength(0);
      expect(pipelineMocks).toHaveLength(0);
    });

    test('with body, with response send timeout, with stalling response', async () => {
      const response = createResponse();

      const destroyed = Promise.withResolvers<Error>();

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', {}) },
        {
          name: 'on',
          callback: ((event: string) => {
            expect(event).toBe('close');

            return nodeResponse;
          }) as ServerResponse['on'],
        },
        {
          name: 'destroy',
          callback: (error?: Error): ServerResponse => {
            destroyed.resolve(error as Error);

            return nodeResponse;
          },
        },
      ]);

      const [pipeline, pipelineMocks] = useFunctionMock<Pipeline>([{ callback: () => undefined }]);

      pipelineHolder.pipeline = pipeline as (...args: Array<unknown>) => unknown;

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter(50);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      responseToNodeResponseEmitter(response, nodeResponse);

      // the timeout must not keep the process alive
      expect((setTimeoutSpy.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false);

      setTimeoutSpy.mockRestore();

      expect((await destroyed.promise).message).toBe('Response has not been fully sent within 50ms');

      expect(nodeResponseMocks).toHaveLength(0);
      expect(pipelineMocks).toHaveLength(0);
    });

    test('with body, with response send timeout, with response sent in time', async () => {
      const response = createResponse();

      const closeListeners: Array<Listener> = [];

      const [nodeResponse, nodeResponseMocks] = useObjectMock<ServerResponse>([
        { name: 'writeHead', callback: createWriteHead(200, 'OK', {}) },
        {
          name: 'on',
          callback: ((event: string, listener: Listener) => {
            expect(event).toBe('close');

            closeListeners.push(listener);

            return nodeResponse;
          }) as ServerResponse['on'],
        },
      ]);

      const [pipeline, pipelineMocks] = useFunctionMock<Pipeline>([{ callback: () => undefined }]);

      pipelineHolder.pipeline = pipeline as (...args: Array<unknown>) => unknown;

      const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter(50);

      responseToNodeResponseEmitter(response, nodeResponse);

      // the response has been fully sent: the timeout gets cleared and must not destroy the response (a destroy call
      // would fail with a missing mock)
      closeListeners.forEach((listener) => listener());

      await wait(100);

      expect(nodeResponseMocks).toHaveLength(0);
      expect(pipelineMocks).toHaveLength(0);
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
