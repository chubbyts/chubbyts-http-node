# chubbyts-http-node

[![CI](https://github.com/chubbyts/chubbyts-http-node/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/chubbyts/chubbyts-http-node/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-http-node/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-http-node?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-http-node%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-http-node/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-http-node.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-http-node)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![sqale_index](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=sqale_index)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)
[![vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-http-node&metric=vulnerabilities)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-http-node)


## Description

Use [@chubbyts/chubbyts-http-types][2] on node.js: turns a node `IncomingMessage` into a `ServerRequest` and emits a
`Response` to a node `ServerResponse`.

The bridge works with any implementation of the types: the server request gets created and changed through the
injected `UriFactory`, `ServerRequestFactory` and `RequestHelpers` (or `ServerRequestHelpers`), for example the ones of
[@chubbyts/chubbyts-http][3].

## Requirements

 * node: 22
 * [@chubbyts/chubbyts-http-types][2]: ^4.0.0

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-http-node][1].

```sh
npm i @chubbyts/chubbyts-http-node@^1.0.0
```

## Usage

```ts
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { Handler } from '@chubbyts/chubbyts-http-types/handler';
import { createServerRequestFactory, createUriFactory } from '@chubbyts/chubbyts-http/message-factory';
import { createServerRequestHelpers } from '@chubbyts/chubbyts-http/message-helper';
import {
  createNodeRequestToServerRequestFactory,
  createResponseToNodeResponseEmitter,
} from '@chubbyts/chubbyts-http-node/node';

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

const nodeRequestToServerRequestFactory = createNodeRequestToServerRequestFactory(
  // any implementation of @chubbyts/chubbyts-http-types
  createUriFactory(),
  createServerRequestFactory(),
  createServerRequestHelpers(),
  // optional: the base url (scheme, host, port and path prefix), defaults to the local address of the socket
  'https://example.com',
  // optional: the request body must be fully received within 30s
  30_000,
);

// for example @chubbyts/chubbyts-framework app (which implements Handler)
declare const handler: Handler;

// argument (optional): the response must be fully sent within 60s
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
```

### Server request

The server request gets created by `serverRequestFactory(method, uriFactory(url))`, then `withProtocolVersion`,
`withSignal`, `withHeader` (for each header) and, except for `GET` and `HEAD`, `withBody` get applied:

 * the url gets built from the base url (scheme, host, port and path prefix) and the origin-form request target, without
   a base url from the local address and port of the socket. Request targets in another form get rejected.
 * `headers` keep every value of a repeated header (e.g. `cookie`), multiple `authorization` or
   `proxy-authorization` headers get rejected. http/2 pseudo-headers (`:method`, `:path`, `:authority`, `:scheme`) get
   skipped.
 * `protocolVersion` is the http version of node, `2.0` becomes `2`.
 * `body` is the `IncomingMessage` itself (an `AsyncIterable<Buffer>`), `GET` and `HEAD` keep the (empty) body of the
   factory.
 * `signal` gets aborted when the `ServerResponse` gets closed before it has been fully sent (client disconnected,
   response destroyed), which is why the factory takes the `ServerResponse` as well.

### Response

The body gets piped into the `ServerResponse`. A node stream body is used as is and a web stream body gets converted
with `Readable.fromWeb`, so both get stopped (destroyed / cancelled) when the client disconnects, even while a read is
pending. Any other `AsyncIterable` can only be stopped once its pending chunk arrives.

### Timeouts

Slow clients (slowloris) can otherwise tie up sockets indefinitely:

 * `createNodeRequestToServerRequestFactory(uriFactory, serverRequestFactory, requestHelpers, baseUrl, requestBodyTimeoutMs)`: if the request body has not been
   fully received within the given time, the request gets destroyed and the error surfaces to the handler
   while iterating the body.
 * `createResponseToNodeResponseEmitter(responseSendTimeoutMs)`: if the response has not been fully sent
   within the given time (slow reading client or stalling response body), the response gets destroyed.

Both timeouts are optional and disabled by default. They only cover the body phases handled by this adapter,
so make sure the node server level timeouts are configured as well: `server.headersTimeout` (slow header
senders), `server.requestTimeout` and `server.keepAliveTimeout`.

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-node
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-http-types
[3]: https://www.npmjs.com/package/@chubbyts/chubbyts-http
