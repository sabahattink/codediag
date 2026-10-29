function requireAuth(req, res, next) {
  if (!req.headers.authorization) {
    res.sendStatus(401);
    return;
  }
  next();
}

module.exports = { requireAuth };
