const { Router } = require("express");
const db = require("../db");

const router = Router();

// Protected by requireAuth where this router is mounted (app.js).
router.delete("/users/:id", (req, res, next) => {
  db.remove(req.params.id)
    .then(() => res.sendStatus(204))
    .catch(next);
});

module.exports = router;
