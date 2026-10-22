// A Railway-template-style Express app. Unchanged by iso.
const express = require("express");
const app = express();
app.use(express.json());
const started = Date.now();

app.get("/", (req, res) => res.json({ ok: true, service: "express-api", env: process.env.ISO_ENV || "local", greeting: process.env.GREETING || "hello", uptimeMs: Date.now() - started }));
app.get("/health", (req, res) => res.send("ok"));
app.get("/env", (req, res) => res.json({ names: Object.keys(process.env).filter((k) => !k.startsWith("AWS_")).sort() }));
app.post("/echo", (req, res) => res.json({ body: req.body, headers: req.headers }));
app.get("/slow", async (req, res) => { await new Promise((r) => setTimeout(r, 500)); res.send("done"); });

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`express-api listening on ${port}`));
