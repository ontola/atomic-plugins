import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A path's body and content type. */
export interface Route {
  type: string;
  body: string;
}

/**
 * Serves fixed routes on 127.0.0.1, on a port the OS picks. A page on
 * http://127.0.0.1 is a secure context, which Web Locks and service
 * workers need.
 */
export async function serve(
  routes: Record<string, Route>,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const route = routes[new URL(request.url ?? '/', 'http://x').pathname];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        'content-type': `${route.type}; charset=utf-8`,
        'cache-control': 'no-store',
      })
      .end(route.body);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export const html = (script: string): Route => ({
  type: 'text/html',
  body: `<!doctype html><meta charset="utf-8"><title>devonian</title><script src="${script}"></script>`,
});

export const js = (body: string): Route => ({
  type: 'text/javascript',
  body,
});
