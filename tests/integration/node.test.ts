import { Readable } from 'node:stream';
import fetch from 'cross-fetch';
import { expect, test } from 'vitest';

test('get', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/get/route?key=value`);

  expect(response.status).toBe(200);
  expect(response.statusText).toBe('OK');
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('set-cookie')).toBe('key1=value1; Path=/, key2=value2; Path=/');

  expect(await response.json()).toMatchInlineSnapshot(`
    {
      "body": "",
      "headers": {
        "accept": [
          "*/*",
        ],
        "accept-encoding": [
          "gzip,deflate",
        ],
        "connection": [
          "keep-alive",
        ],
        "user-agent": [
          "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
        ],
      },
      "method": "GET",
      "protocolVersion": "1.1",
      "uri": {
        "fragment": "",
        "host": "example.com",
        "path": "/path/to/get/route",
        "query": "key=value",
        "scheme": "https",
        "userInfo": "",
      },
    }
  `);
});

test('handler error', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/error/route`);

  expect(response.status).toBe(500);
  expect(response.headers.get('content-type')).toBe('text/plain');

  expect(await response.text()).toBe('Internal Server Error');
});

test('post', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/post/route`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'test' }),
  });

  expect(response.status).toBe(200);
  expect(response.statusText).toBe('OK');
  expect(response.headers.get('content-type')).toBe('application/json');

  expect(await response.json()).toMatchInlineSnapshot(`
    {
      "body": "{"message":"test"}",
      "headers": {
        "accept": [
          "*/*",
        ],
        "accept-encoding": [
          "gzip,deflate",
        ],
        "connection": [
          "keep-alive",
        ],
        "content-length": [
          "18",
        ],
        "content-type": [
          "application/json",
        ],
        "user-agent": [
          "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
        ],
      },
      "method": "POST",
      "protocolVersion": "1.1",
      "uri": {
        "fragment": "",
        "host": "example.com",
        "path": "/path/to/post/route",
        "query": "",
        "scheme": "https",
        "userInfo": "",
      },
    }
  `);
});

// the server must survive a request exceeding the body limit
const expectServerAlive = async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/post/route`, { method: 'POST', body: 'test' });

  expect(response.status).toBe(200);
  expect((await response.json()).body).toBe('test');
};

test('post, with too large body', async () => {
  await expect(
    fetch(`${process.env.HTTP_URI}/path/to/post/route`, {
      method: 'POST',
      body: 'a'.repeat(2 * 1024 * 1024),
    }),
  ).rejects.toThrow();

  await expectServerAlive();
});

test('post, with too large chunked body', async () => {
  // a stream body without content-length gets sent chunked: limited while reading it
  await expect(
    fetch(`${process.env.HTTP_URI}/path/to/post/route`, {
      method: 'POST',
      body: Readable.from(Array.from({ length: 32 }, () => Buffer.alloc(64 * 1024, 'a'))) as unknown as BodyInit,
    }),
  ).rejects.toThrow();

  await expectServerAlive();
});
