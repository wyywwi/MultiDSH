// Deploy the bundled Directory Worker to Cloudflare through the local
// mcp-oauth-gateway (Cloudflare API MCP "execute" tool).
//
// Why not wrangler: this machine authenticates to Cloudflare through the MCP
// OAuth gateway, not an API token. The gateway exposes a code-execution tool
// that can call the Cloudflare API, which is enough to create/reuse D1, apply
// the schema, upload the bundle and attach the custom domain.
//
// Usage (from multidsh/):
//   node scripts/bundle-worker.mjs --check
//   node scripts/cf-deploy.mjs [--hostname multidsh.example.com] [--dry-run]
//
// Env:
//   MCP_GATEWAY_URL    default http://127.0.0.1:33419/mcp
//   MCP_GATEWAY_TOKEN  default read from %USERPROFILE%/.dsh/profiles/desktop/cordis.patch.yml
//   CF_ACCOUNT_ID      required Cloudflare account id
//   CF_ZONE_ID         required Cloudflare zone id (for the custom domain)
//   DIRECTORY_HOSTNAME optional custom hostname (default multidsh.example.com)

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE = path.join(ROOT, 'packages', 'directory-worker', 'dist', 'worker.js');
const SCHEMA = path.join(ROOT, 'packages', 'directory-worker', 'schema.sql');
const SCRIPT_NAME = 'multidsh-directory';
const D1_TITLE = 'multidsh_directory';
const DEFAULT_HOSTNAME = 'multidsh.example.com';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const HOSTNAME = argValue('--hostname', process.env.DIRECTORY_HOSTNAME || DEFAULT_HOSTNAME);
const DRY_RUN = args.includes('--dry-run');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const ZONE_ID = process.env.CF_ZONE_ID || '';
const GATEWAY_URL = process.env.MCP_GATEWAY_URL || 'http://127.0.0.1:33419/mcp';

function gatewayToken() {
  if (process.env.MCP_GATEWAY_TOKEN) return process.env.MCP_GATEWAY_TOKEN;
  const profile = path.join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const text = fs.readFileSync(profile, 'utf8');
  const match = text.match(/x-mcp-gateway-token:\s*['"]?([^'"\s]+)/);
  if (!match) throw new Error('cannot find x-mcp-gateway-token in profile');
  return match[1];
}

const TOKEN = gatewayToken();
const BASE = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-mcp-gateway-token': TOKEN,
};
let session = null;

async function mcpPost(body) {
  const headers = { ...BASE };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(GATEWAY_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  const type = res.headers.get('content-type') || '';
  const messages = [];
  if (type.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        messages.push(JSON.parse(line.slice(5).trim()));
      } catch {
        /* ignore keepalive noise */
      }
    }
  } else if (text.trim()) {
    messages.push(JSON.parse(text));
  }
  return messages;
}

async function callTool(name, argsObject) {
  await mcpPost({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'multidsh-deploy', version: '1.0' } },
  });
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const messages = await mcpPost({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: argsObject },
  });
  const reply = messages.find((m) => m.id === 2);
  if (!reply) throw new Error(`MCP ${name}: no reply`);
  if (reply.error) throw new Error(`MCP ${name}: ${JSON.stringify(reply.error)}`);
  const content = reply.result?.content || [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (reply.result?.isError) throw new Error(`MCP ${name} error: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildDeployCode(source, schema) {
  return `async () => {
  const account = accountId;
  const d1Title = ${JSON.stringify(D1_TITLE)};
  const schema = ${JSON.stringify(schema)};
  const scriptName = ${JSON.stringify(SCRIPT_NAME)};
  const hostname = ${JSON.stringify(HOSTNAME)};
  const zoneId = ${JSON.stringify(ZONE_ID)};
  const source = ${JSON.stringify(source)};

  // 1) D1 database: pool/device/token metadata + high-frequency liveness.
  const d1List = await cloudflare.request({ method: 'GET', path: '/accounts/' + account + '/d1/database' });
  let d1 = (d1List.result || []).find((item) => item.name === d1Title);
  let createdD1 = false;
  if (!d1) {
    const res = await cloudflare.request({ method: 'POST', path: '/accounts/' + account + '/d1/database', body: { name: d1Title } });
    d1 = res.result;
    createdD1 = true;
  }
  const schemaResult = await cloudflare.request({
    method: 'POST',
    path: '/accounts/' + account + '/d1/database/' + d1.uuid + '/query',
    body: { sql: schema },
  });

  // 2) Upload the worker bundle as an ES module with the D1 binding.
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-10-20',
    bindings: [
      { type: 'd1', name: 'FLEET_DB', database_id: d1.uuid },
      { type: 'ratelimit', name: 'CREATE_POOL_RATE_LIMITER', namespace_id: '1001', simple: { limit: 3, period: 60 } },
      { type: 'ratelimit', name: 'JOIN_RATE_LIMITER', namespace_id: '1002', simple: { limit: 10, period: 60 } },
    ],
    observability: { enabled: true, head_sampling_rate: 1 },
  };
  const boundary = '----multidsh' + Date.now();
  const body = [
    '--' + boundary,
    'Content-Disposition: form-data; name="metadata"',
    'Content-Type: application/json',
    '',
    JSON.stringify(metadata),
    '--' + boundary,
    'Content-Disposition: form-data; name="worker.js"; filename="worker.js"',
    'Content-Type: application/javascript+module',
    '',
    source,
    '--' + boundary + '--',
    '',
  ].join('\\r\\n');
  const upload = await cloudflare.request({
    method: 'PUT',
    path: '/accounts/' + account + '/workers/scripts/' + scriptName,
    body,
    contentType: 'multipart/form-data; boundary=' + boundary,
    rawBody: true,
  });

  // 3) Custom domain (idempotent by hostname).
  const domains = await cloudflare.request({ method: 'GET', path: '/accounts/' + account + '/workers/domains' });
  let domain = (domains.result || []).find((d) => d.hostname === hostname);
  let createdDomain = false;
  if (!domain) {
    const res = await cloudflare.request({
      method: 'PUT',
      path: '/accounts/' + account + '/workers/domains',
      body: { zone_id: zoneId, hostname, service: scriptName, environment: 'production' },
    });
    domain = res.result;
    createdDomain = true;
  }

  return {
    d1: { uuid: d1.uuid, name: d1.name, created: createdD1, schema: schemaResult.success },
    script: { name: scriptName, etag: upload.result && upload.result.etag, modified_on: upload.result && upload.result.modified_on },
    domain: { hostname: domain.hostname, service: domain.service, zone_name: domain.zone_name, cert_id: domain.cert_id, created: createdDomain },
    account,
  };
}`;
}

async function main() {
  if (!ACCOUNT_ID || !ZONE_ID) {
    throw new Error('set CF_ACCOUNT_ID and CF_ZONE_ID (and optionally DIRECTORY_HOSTNAME) before deploying');
  }
  if (!fs.existsSync(BUNDLE)) {
    throw new Error(`bundle missing: ${BUNDLE}\nrun: node scripts/bundle-worker.mjs --check`);
  }
  if (!fs.existsSync(SCHEMA)) throw new Error(`schema missing: ${SCHEMA}`);
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const schema = fs.readFileSync(SCHEMA, 'utf8');
  if (!source.includes('export default __workerEntry')) throw new Error('bundle has no default export');
  console.log(`deploying ${SCRIPT_NAME} (${source.length} bytes) -> https://${HOSTNAME}`);
  if (DRY_RUN) {
    console.log('dry run: would create/reuse D1, apply schema, upload bundle, attach custom domain');
    return;
  }
  const result = await callTool('execute', { code: buildDeployCode(source, schema), account_id: ACCOUNT_ID });
  console.log(JSON.stringify(result, null, 2));
  const out = path.join(ROOT, 'packages', 'directory-worker', 'dist', 'deploy.json');
  fs.writeFileSync(out, `${JSON.stringify({ hostname: HOSTNAME, ...result }, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, out)}`);
}

main().catch((err) => {
  console.error('deploy failed:', err.stack || err.message);
  process.exit(1);
});
