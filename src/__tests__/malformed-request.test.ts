/**
 * Robustness probe for the Node HTTP transport (src/http.ts): a request whose
 * Host header or request target cannot be parsed must never throw out of the
 * request listener (which would take the whole process down before auth).
 * Unparseable targets answer 400 and the server keeps serving.
 *
 * Raw sockets are used because fetch() refuses to send these requests.
 * Regression test for WYREAI-741 (reference fix: halopsa-mcp#113).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { connect, createServer as createNetServer } from 'node:net';
import type { Server } from 'node:http';
import { startHttpTransport } from '../index.js';

let server: Server;
let port: number;

/** Ask the OS for a free port by briefly binding port 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  port = await getFreePort();
  process.env.MCP_HTTP_PORT = String(port);
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.MCP_ALLOW_INSECURE_DEV = '1';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.AUTH_MODE;
  const started = (await startHttpTransport()) as unknown as Server & { server?: Server; httpServer?: Server };
  // Some transports return a wrapper that holds the listener.
  server = started.server ?? started.httpServer ?? started;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/** Send raw HTTP bytes, return the status line and body. */
function rawRequest(payload: string): Promise<{ status: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const [head, body = ''] = data.split('\r\n\r\n');
      resolve({ status: head.split('\r\n')[0], body });
    });
  });
}

const HEALTH = 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';

describe('malformed requests on the Node HTTP transport (ninjaone-mcp)', () => {
  it('serves a request with a malformed Host header and keeps running', async () => {
    const res = await rawRequest('GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n');
    expect(res.status).toBe('HTTP/1.1 200 OK');
    expect((await rawRequest(HEALTH)).status).toBe('HTTP/1.1 200 OK');
  });

  it('answers 400 for an unparseable request target and keeps running', async () => {
    const res = await rawRequest('GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(res.status).toBe('HTTP/1.1 400 Bad Request');
    expect(res.body).toContain('{"error":"Bad request"}');
    expect((await rawRequest(HEALTH)).status).toBe('HTTP/1.1 200 OK');
  });

  it('serves an HTTP/1.0 request that has no Host header', async () => {
    const res = await rawRequest('GET /health HTTP/1.0\r\n\r\n');
    expect(res.status).toBe('HTTP/1.1 200 OK');
  });
});
