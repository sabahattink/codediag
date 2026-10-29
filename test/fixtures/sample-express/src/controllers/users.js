const db = require("../db");

exports.list = async (req, res, next) => {
  try {
    res.json(await db.all());
  } catch (err) {
    next(err);
  }
};

exports.remove = (req, res, next) => {
  db.remove(req.params.id)
    .then(() => res.sendStatus(204))
    .catch(next);
};
