function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json(result.error.issues);
      return;
    }
    next();
  };
}

module.exports = { validate };
