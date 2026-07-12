import type { Request, Response } from "express";
import type { AtIdentifierString } from "@atproto/lex";
import { PDS, envToCfg, envToSecrets, readEnv, httpLogger } from "@atproto/pds";
import pkg from "@atproto/pds/package.json" with { type: "json" };

// matches docker tag used in compose file, may deviate from @atproto/pds version.
const DISTRO_VER = "0.4";

const main = async () => {
  const env = readEnv();
  env.version ||= ver(DISTRO_VER, pkg.version);
  const cfg = envToCfg(env);
  const secrets = envToSecrets(env);
  const pds = await PDS.create(cfg, secrets);
  await pds.start();
  httpLogger.info("pds has started");
  pds.app.get("/tls-check", (req, res) => {
    checkHandleRoute(pds, req, res);
  });
  process.on("SIGTERM", async () => {
    httpLogger.info("pds is stopping");
    await pds.destroy();
    httpLogger.info("pds is stopped");
  });
};

// Operator subdomains that should get on-demand TLS certs even though they are
// not user handles — e.g. the admin dashboard / atcr-webhook host
// (admin.laugh.town). They match the `*.laugh.town` on-demand policy in Caddy, so
// the `ask` endpoint (checkHandleRoute) is consulted for them; without this they
// fall through to the 404 below and Caddy refuses to issue, breaking their TLS.
// (The PDS service hostname is already approved separately via service.hostname.)
// Configurable via PDS_ONDEMAND_ALLOW_HOSTS (comma-separated); admin.laugh.town is
// included by default so the fix works without touching the box env.
const OPERATOR_TLS_HOSTS = new Set(
  ["admin.laugh.town", ...(process.env.PDS_ONDEMAND_ALLOW_HOSTS ?? "").split(",")]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

async function checkHandleRoute(pds: PDS, req: Request, res: Response) {
  try {
    const { domain } = req.query;
    if (!domain || typeof domain !== "string") {
      return res.status(400).json({
        error: "InvalidRequest",
        message: "bad or missing domain query param",
      });
    }
    if (domain === pds.ctx.cfg.service.hostname) {
      return res.json({ success: true });
    }
    if (OPERATOR_TLS_HOSTS.has(domain.toLowerCase())) {
      return res.json({ success: true });
    }
    const isHostedHandle = pds.ctx.cfg.identity.serviceHandleDomains.find(
      (avail) => domain.endsWith(avail),
    );
    if (!isHostedHandle) {
      return res.status(400).json({
        error: "InvalidRequest",
        message: "handles are not provided on this domain",
      });
    }
    const account = await pds.ctx.accountManager.getAccount(
      domain as AtIdentifierString,
    );
    if (!account) {
      return res.status(404).json({
        error: "NotFound",
        message: "handle not found for this domain",
      });
    }
    return res.json({ success: true });
  } catch (err) {
    httpLogger.error({ err }, "check handle failed");
    return res.status(500).json({
      error: "InternalServerError",
      message: "Internal Server Error",
    });
  }
}

// e.g. ver('0.4', '0.5.1') -> '0.4.5001'
function ver(base: `${string}.${string}`, pkgver: string) {
  const { 0: major, 1: minor, 2: patch, length } = pkgver.split(".");
  if (length !== 3) return pkgver;
  if (major !== "0") return pkgver;
  if (minor === "" || minor === "0") return pkgver;
  if (patch === "") return pkgver;
  return `${base}.${minor}${patch.padStart(3, "0")}`;
}

main();
