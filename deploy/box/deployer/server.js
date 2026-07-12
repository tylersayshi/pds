// atcr "Image push" webhook receiver -> pull & restart the pds container.
//
// Zero dependencies (Node builtins only). Runs on the bag box as a container in the
// same compose project as `pds` (see ../compose.snippet.yaml). Reachable only through
// Caddy at https://admin.laugh.town/hooks/atcr; every request is HMAC-verified.
//
// Env:
//   ATCR_WEBHOOK_SECRET  (required)  the signing secret configured in atcr's Webhooks panel
//   COMPOSE_FILE         default /pds/compose.yaml   compose file to act on
//   DEPLOY_SERVICE       default pds                 service to pull & recreate
//   DEPLOY_TAG           default latest              only this image tag triggers a deploy
//   PORT                 default 8787

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';

const SECRET = process.env.ATCR_WEBHOOK_SECRET;
const COMPOSE_FILE = process.env.COMPOSE_FILE || '/pds/compose.yaml';
const DEPLOY_SERVICE = process.env.DEPLOY_SERVICE || 'pds';
const DEPLOY_TAG = process.env.DEPLOY_TAG || 'latest';
const EXPECTED_REPO = process.env.EXPECTED_REPO || 'laugh.town/pds';
const PORT = Number(process.env.PORT || 8787);

if (!SECRET) {
  console.error('FATAL: ATCR_WEBHOOK_SECRET is not set');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Verify the X-Webhook-Signature-256 header against an HMAC-SHA256 of the raw body.
// atcr's header value is expected to be hex, optionally "sha256=" prefixed — accept both.
function verify(rawBody, header) {
  if (!header) return false;
  const provided = String(header).replace(/^sha256=/, '');
  const expected = createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Coalesce overlapping deploys: if a deploy is running and more hooks arrive, run exactly
// one more pass afterwards instead of stacking N restarts.
let deploying = false;
let queued = false;

function deploy() {
  if (deploying) { queued = true; return; }
  deploying = true;
  log(`deploy: pull ${DEPLOY_SERVICE}`);
  execFile('docker', ['compose', '-f', COMPOSE_FILE, 'pull', DEPLOY_SERVICE], (e1, _o1, err1) => {
    if (e1) log('pull failed:', err1 || e1.message);
    log(`deploy: up -d ${DEPLOY_SERVICE}`);
    execFile('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', DEPLOY_SERVICE], (e2, _o2, err2) => {
      if (e2) log('up failed:', err2 || e2.message);
      else log('deploy: done');
      deploying = false;
      if (queued) { queued = false; deploy(); }
    });
  });
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.method !== 'POST' || req.url !== '/hooks/atcr') { res.writeHead(404); return res.end(); }

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1_000_000) { req.destroy(); return; }   // 1MB cap
    chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (!verify(raw, req.headers['x-webhook-signature-256'])) {
      log('rejected: bad signature');
      res.writeHead(401); return res.end();
    }

    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); }
    catch { res.writeHead(400); return res.end(); }

    // FILTER — confirmed against a real atcr payload (2026-07-11). A single `docker push`
    // fires ~3 webhook calls: the platform image manifest and buildx's provenance/attestation
    // manifest (both media_type ...image.manifest.v1+json, NO tag), plus the OCI image index
    // (media_type ...image.index.v1+json) which is the ONLY call carrying push_data.tag.
    // Gating on push_data.tag === DEPLOY_TAG therefore both selects the tagged event and
    // dedupes the two untagged calls -> exactly one deploy per push.
    const trigger = evt.trigger;                            // "push"
    const tag = evt.push_data && evt.push_data.tag;         // "latest" | "sha-..." | undefined
    const repo = evt.repository && evt.repository.repo_name; // "laugh.town/pds"
    const digest = evt.push_data && evt.push_data.digest;

    if (trigger !== 'push' || repo !== EXPECTED_REPO || tag !== DEPLOY_TAG) {
      log(`ignored: trigger=${trigger} tag=${tag} repo=${repo}`);
      res.writeHead(204); return res.end();
    }

    log(`accepted: tag=${tag} repo=${repo} digest=${digest} -> deploying`);
    res.writeHead(202); res.end();
    deploy();
  });
});

server.listen(PORT, () => log(`atcr deployer listening on :${PORT} (service=${DEPLOY_SERVICE}, tag=${DEPLOY_TAG})`));
