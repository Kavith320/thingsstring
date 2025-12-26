const express = require("express");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Hello IoT Backend 👋" });
});

module.exports = app;
