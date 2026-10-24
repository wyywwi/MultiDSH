// Fake dsh CLI for local CLI/integration tests (no real DSH install needed).
// Mimics the one line the host supervisor parses: `dsh web: <url>?token=...`
import http from 'node:http';

const portIndex = process.argv.indexOf('--port');
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 0);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><h1>fake dsh</h1><p>port ${port} path ${req.url}</p>`);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`dsh web: http://127.0.0.1:${port}/?token=fake-token-${port}`);
});
