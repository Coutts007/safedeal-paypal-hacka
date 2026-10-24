// A stand-in for the PayPal sandbox REST API, for the Playwright tests only (port 4010). It keeps
// the rules SafeDeal relies on: an order is authorised once, a hold is captured or voided once,
// and a repeated PayPal-Request-Id replays the first answer. Every call is recorded so a test can
// check what the server sent (amount, payee, request ids). Control routes start with /__.
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PAYPAL_PORT ?? 4010);
const DAY = 24 * 3_600_000;

// Ids keep counting across resets: like PayPal, the fake never reuses an order or hold id (the
// e2e database keeps the ids of earlier tests).
let n = 0;
let state;
function reset() {
  state = {
    orders: new Map(),
    auths: new Map(),
    replies: new Map(),
    calls: [],
    /** Issue to fail the next call of a kind with, e.g. { authorize: "TRANSACTION_REFUSED" }. */
    failNext: {},
  };
}
reset();

const id = (prefix) => `${prefix}${String(++n).padStart(6, "0")}E2E`;
const error = (status, issue) => ({
  status,
  json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue }], debug_id: `dbg${n}` },
});

function orderJson(o) {
  const auth = o.authId && state.auths.get(o.authId);
  const unit = o.body.purchase_units[0];
  return {
    id: o.id,
    status: o.status,
    purchase_units: [
      {
        ...unit,
        ...(auth && {
          payments: {
            authorizations: [{ id: auth.id, status: auth.status, expiration_time: auth.expiresAt }],
          },
        }),
      },
    ],
  };
}

function authJson(a) {
  return {
    id: a.id,
    status: a.status,
    expiration_time: a.expiresAt,
    amount: a.amount,
  };
}

function handle(method, path, body) {
  let m;
  if (method === "POST" && path === "/v1/oauth2/token") {
    return { status: 200, json: { access_token: "fake-access-token", expires_in: 32_400 } };
  }
  if (method === "POST" && path === "/v2/checkout/orders") {
    const o = { id: id("ORD"), status: "PAYER_ACTION_REQUIRED", body, authId: null };
    state.orders.set(o.id, o);
    return { status: 201, json: orderJson(o) };
  }
  if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)$/)) && method === "GET") {
    const o = state.orders.get(m[1]);
    if (!o) return error(404, "RESOURCE_NOT_FOUND");
    // The buyer approves in the PayPal window, which the browser stub stands in for.
    return { status: 200, json: orderJson({ ...o, status: o.authId ? "COMPLETED" : "APPROVED" }) };
  }
  if ((m = path.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/)) && method === "POST") {
    const o = state.orders.get(m[1]);
    if (!o) return error(404, "RESOURCE_NOT_FOUND");
    if (state.failNext.authorize) {
      const issue = state.failNext.authorize;
      delete state.failNext.authorize;
      return error(422, issue);
    }
    if (o.authId) return error(422, "ORDER_ALREADY_AUTHORIZED");
    const a = {
      id: id("AUTH"),
      status: "CREATED",
      orderId: o.id,
      amount: o.body.purchase_units[0].amount,
      expiresAt: new Date(Date.now() + 29 * DAY).toISOString(),
    };
    state.auths.set(a.id, a);
    o.authId = a.id;
    o.status = "COMPLETED";
    return { status: 201, json: orderJson(o) };
  }
  if ((m = path.match(/^\/v2\/payments\/authorizations\/([^/]+)(\/capture|\/void)?$/))) {
    const a = state.auths.get(m[1]);
    if (!a) return error(404, "RESOURCE_NOT_FOUND");
    if (method === "GET" && !m[2]) return { status: 200, json: authJson(a) };
    if (method === "POST" && m[2]) {
      if (a.status === "CAPTURED") return error(422, "AUTHORIZATION_ALREADY_CAPTURED");
      if (a.status === "VOIDED") return error(422, "AUTHORIZATION_VOIDED");
      if (a.status !== "CREATED") return error(422, "AUTHORIZATION_EXPIRED");
      if (m[2] === "/void") {
        a.status = "VOIDED";
        return { status: 204, json: null };
      }
      a.status = "CAPTURED";
      a.captureId = id("CAP");
      return { status: 201, json: { id: a.captureId, status: "COMPLETED" } };
    }
  }
  if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
    const ok = body?.transmission_sig !== "bad-signature";
    return { status: 200, json: { verification_status: ok ? "SUCCESS" : "FAILURE" } };
  }
  return error(404, "NOT_FOUND");
}

function control(method, path, body) {
  if (method === "GET" && path === "/__calls") return { status: 200, json: state.calls };
  if (method === "POST" && path === "/__reset") {
    reset();
    return { status: 200, json: { ok: true } };
  }
  if (method === "POST" && path === "/__fail") {
    Object.assign(state.failNext, body);
    return { status: 200, json: { ok: true } };
  }
  if (method === "GET" && path === "/__auths") {
    return {
      status: 200,
      json: [...state.auths.values()].map((a) => ({ ...authJson(a), orderId: a.orderId })),
    };
  }
  const m = path.match(/^\/__auths\/([^/]+)$/);
  if (m && method === "POST") {
    const a = state.auths.get(m[1]);
    if (!a) return { status: 404, json: { error: "no such authorization" } };
    a.status = body.status;
    return { status: 200, json: authJson(a) };
  }
  if (m && method === "GET") {
    const a = state.auths.get(m[1]);
    return a
      ? { status: 200, json: { ...authJson(a), captureId: a.captureId } }
      : { status: 404, json: {} };
  }
  return null;
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const path = new URL(req.url, "http://x").pathname;
    let body = null;
    try {
      body = raw && req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    let reply = path.startsWith("/__") ? control(req.method, path, body) : null;
    if (!reply) {
      const requestId = req.headers["paypal-request-id"] ?? null;
      const key = requestId && `${req.method} ${path} ${requestId}`;
      state.calls.push({ method: req.method, path, requestId, body });
      reply = key && state.replies.get(key);
      if (!reply) {
        reply = handle(req.method, path, body);
        if (key) state.replies.set(key, reply);
      }
    }
    res.writeHead(reply.status, {
      "content-type": "application/json",
      "paypal-debug-id": `fake${n}`,
    });
    res.end(reply.json === null ? "" : JSON.stringify(reply.json));
  });
}).listen(PORT, () => console.log(`fake PayPal on http://localhost:${PORT}`));
