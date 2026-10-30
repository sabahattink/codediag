const { execSync } = require('node:child_process');

function convert(format) {
  return execSync(`convert upload.png output.${format}`).toString();
}

module.exports = { convert };
