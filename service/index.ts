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
  installOAuthDiag(pds);
  pds.app.get("/tls-check", (req, res) => {
    checkHandleRoute(pds, req, res);
  });
  process.on("SIGTERM", async () => {
    httpLogger.info("pds is stopping");
    await pds.destroy();
    httpLogger.info("pds is stopped");
  });
};

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

// --- OAuth diagnostic logging (TEMPORARY — remove once the authorize race is
// diagnosed) -----------------------------------------------------------------
// Logs every GET /oauth/authorize and POST /oauth/par with its request_uri,
// response status, and duration, so we can correlate the intermittent authorize
// `InvalidRequestError` ("The data you submitted is invalid"). The open question
// is whether the browser hits /oauth/authorize with a request_uri *before* the
// PAR that mints it has completed (a client-side ordering/race), which server
// logs otherwise don't reveal (the oauth-provider renders the error without
// logging its reason). Match each authorize's `request_uri` against a preceding
// par's minted `request_uri` + timestamps. Log-only; no behavior change. Parses
// req.url directly (not Express getters) so it can run at the front of the stack
// before the oauth router handles the route.
function installOAuthDiag(pds: PDS) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = pds.app as any;
  const mw = (req: Request, res: Response, next: () => void) => {
    let pathname = "";
    let requestUri: string | null = null;
    try {
      const u = new URL(req.url ?? "", "http://pds.internal");
      pathname = u.pathname;
      requestUri = u.searchParams.get("request_uri");
    } catch {
      return next();
    }
    const isAuth = req.method === "GET" && pathname === "/oauth/authorize";
    const isPar = req.method === "POST" && pathname === "/oauth/par";
    if (!isAuth && !isPar) return next();

    const start = Date.now();

    // Best-effort capture of the request_uri a PAR mints. The body is JSON but
    // may be compressed in prod; parse is guarded and skipped if not plain JSON.
    let parBody = "";
    if (isPar) {
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).write = (chunk: any, ...rest: any[]) => {
        try {
          if (chunk) {
            parBody += Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : String(chunk);
          }
        } catch {
          // ignore capture failures
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origWrite as any)(chunk, ...rest);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).end = (chunk: any, ...rest: any[]) => {
        try {
          if (chunk && typeof chunk !== "function") {
            parBody += Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : String(chunk);
          }
        } catch {
          // ignore capture failures
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origEnd as any)(chunk, ...rest);
      };
    }

    res.on("finish", () => {
      const ms = Date.now() - start;
      if (isAuth) {
        httpLogger.info(
          {
            diag: "oauthdiag",
            kind: "authorize",
            status: res.statusCode,
            request_uri: requestUri,
            ms,
          },
          "oauthdiag authorize",
        );
      } else {
        let minted: string | undefined;
        if (parBody.startsWith("{")) {
          try {
            minted = JSON.parse(parBody).request_uri;
          } catch {
            // compressed or partial body — timing + status are still useful
          }
        }
        httpLogger.info(
          {
            diag: "oauthdiag",
            kind: "par",
            status: res.statusCode,
            request_uri: minted,
            ms,
          },
          "oauthdiag par",
        );
      }
    });

    next();
  };

  // PDS.create already mounted the oauth router, so appending a middleware would
  // sit *after* it and never run for these routes. Register, then move our layer
  // to the front of the Express stack so it runs first and calls next().
  app.use(mw);
  const stack = app._router?.stack;
  if (Array.isArray(stack) && stack.length > 1) {
    stack.unshift(stack.pop());
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
