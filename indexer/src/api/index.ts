// HTTP API surface.
//
// Ponder requires this file to exist (it default-exports the Hono app that backs the server).
// Item 2 is health-checks-only, so we register NO custom routes: a bare Hono app. Ponder still
// serves its reserved /health, /ready, /status, /metrics endpoints automatically — those are the
// health checks. The balance/transaction routes (item 3/4) get registered on `app` later.
import { Hono } from "hono";

const app = new Hono();

// TODO(item 3/4): app.get("/balances", ...) and app.get("/transactions", ...).

export default app;
