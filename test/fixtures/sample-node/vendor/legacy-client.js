// Deliberately planted FAKE credential in an ignored directory (see .codediag.yml).
// codediag must not report it while vendor/ is ignored.
const client = {
  password: "fixture-only-not-a-secret",
};

module.exports = client;
