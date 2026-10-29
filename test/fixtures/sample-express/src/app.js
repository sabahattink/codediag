const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { requireAuth } = require("./middleware/auth");
const usersRouter = require("./routes/users");
const adminRouter = require("./routes/admin");

const app = express();

app.use(helmet());
app.use(cors()); // allows any origin (reported by the security analyzer)
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Public by design: not reported as missing auth.
app.post("/login", async (req, res, next) => {
  try {
    res.json({ token: String(req.body.email) });
  } catch (err) {
    next(err);
  }
});

app.use("/users", usersRouter);
app.use("/admin", requireAuth, adminRouter);

module.exports = app;
