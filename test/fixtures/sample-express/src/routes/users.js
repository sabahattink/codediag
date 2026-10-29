const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { userSchema } = require("../schemas/user");
const usersController = require("../controllers/users");
const db = require("../db");

const router = express.Router();

router.get("/", usersController.list);

// No auth, no validation and an async handler without error handling (3 warnings).
router.post("/", async (req, res) => {
  const user = await db.insert(req.body);
  res.status(201).json(user);
});

router.put("/:id", requireAuth, validate(userSchema), async (req, res, next) => {
  try {
    res.json(await db.update(req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAuth, usersController.remove);

module.exports = router;
