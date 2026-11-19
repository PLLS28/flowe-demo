import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.wasm', 'application/wasm'],
  ['.task', 'application/octet-stream'],
  ['.svg', 'image/svg+xml']
]);

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value ?? '');
  if (!match || (!match[1] && !match[2])) return null;

  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (start > end || start >= size) return null;

  return { start, end };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = resolve(root, `.${pathname}`);

    if (!filePath.startsWith(`${root}${sep}`) && filePath !== root) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const details = await stat(filePath);
    if (!details.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }

    const extension = extname(filePath).toLowerCase();
    const revalidate = ['.html', '.js', '.mjs', '.css', '.json'].includes(extension);
    const headers = {
      'Content-Type': mimeTypes.get(extension) ?? 'application/octet-stream',
      'Cache-Control': revalidate ? 'no-store' : 'public, max-age=86400',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes'
    };

    if (request.headers.range) {
      const range = parseRange(request.headers.range, details.size);
      if (!range) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${details.size}` });
        response.end();
        return;
      }

      response.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${details.size}`,
        'Content-Length': range.end - range.start + 1
      });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        createReadStream(filePath, range).pipe(response);
      }
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, { ...headers, 'Content-Length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const statusCode = error?.code === 'ENOENT' ? 404 : 500;
    response.writeHead(statusCode).end(statusCode === 404 ? 'Not found' : 'Server error');
  }
});

let port = Number(process.env.PORT) || 4173;
let attempts = 0;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && attempts < 20) {
    attempts += 1;
    port += 1;
    server.listen(port, '127.0.0.1');
    return;
  }
  console.error(error);
  process.exitCode = 1;
});

server.on('listening', () => {
  console.log(`For you -> http://localhost:${port}`);
  console.log('Press Ctrl+C to stop the server.');
});

server.listen(port, '127.0.0.1');
