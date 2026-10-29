import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import type { Response, ServerRequest } from '@chubbyts/chubbyts-http-types/message';
import {
  createResponseFactory,
  createServerRequestFactory,
  createStreamFactory,
  createUriFactory,
} from '@chubbyts/chubbyts-http/message-factory';
import { createResponseHelpers, createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import { createNodeRequestToServerRequestFactory, createResponseToNodeResponseEmitter } from '../../src/node.js';

const serverHost = process.env.SERVER_HOST as string;
const serverPort = parseInt(process.env.SERVER_PORT as string);

const shutdownServer = (server: Server) => {
  server.close((err) => {
    if (err) {
      console.warn(`Shutdown server with error: ${err}`);
      process.exit(1);
    }

    console.log('Shutdown server');
    process.exit(0);
  });
};

// any implementation of @chubbyts/chubbyts-http-types, here @chubbyts/chubbyts-http
const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
  createUriFactory(),
  createServerRequestFactory(),
  createServerRequestHelpers(),
  'https://example.com',
  30_000,
);

const responseFactory = createResponseFactory();
const streamFactory = createStreamFactory();
const responseHelpers = createResponseHelpers();

const handler: Handler = async (serverRequest: ServerRequest): Promise<Response> => {
  if (serverRequest.uri.path === '/path/to/error/route') {
    throw new Error('Handler failure');
  }

  const { host: _, ...otherHeaders } = serverRequest.headers;

  const response = responseHelpers.withBody(
    responseFactory(200),
    streamFactory(
      JSON.stringify({
        method: serverRequest.method,
        uri: serverRequest.uri,
        protocolVersion: serverRequest.protocolVersion,
        headers: otherHeaders,
        body: await text(serverRequest.body),
      }),
    ),
  );

  return responseHelpers.withAddedHeader(
    responseHelpers.withHeader(response, 'content-type', 'application/json'),
    'set-cookie',
    ['key1=value1; Path=/', 'key2=value2; Path=/'],
  );
};

const responseToNodeResponseEmitter = createResponseToNodeResponseEmitter(60_000);

const server = createServer(async (req, res) => {
  try {
    const serverRequest = nodeRequestToServerRequestFactory(req, res);
    const response = await handler(serverRequest);
    responseToNodeResponseEmitter(response, res);
  } catch (error) {
    console.error(`Failed to handle request: ${error}`);

    // once headers are sent the response cannot be turned into a 500 anymore:
    // destroying the socket is the only way to signal the failure to the client
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));

      return;
    }

    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error');
  }
});

server.listen(serverPort, serverHost, () => {
  console.log(`Listening to ${serverHost}:${serverPort}`);
});

process.on('SIGINT', () => shutdownServer(server));
process.on('SIGTERM', () => shutdownServer(server));
