const { z } = require("zod");

exports.userSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
});
