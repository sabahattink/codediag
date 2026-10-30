const fs = require('node:fs');
const path = require('node:path');

const PAGES = path.join(__dirname, '..', '..', 'pages');

// Every caller passes a constant page name.
function readPage(name) {
  return fs.readFileSync(path.join(PAGES, `${name}.html`), 'utf8');
}

module.exports = { readPage };
