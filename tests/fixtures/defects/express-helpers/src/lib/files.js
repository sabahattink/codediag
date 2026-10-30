const path = require('node:path');

const UPLOADS = path.join(__dirname, '..', '..', 'uploads');
const AVATARS = path.join(__dirname, '..', '..', 'avatars');

function sendUpload(res, name) {
  res.sendFile(path.join(UPLOADS, name));
}

// path.basename() keeps the name inside the directory.
function sendAvatar(res, name) {
  res.sendFile(path.join(AVATARS, path.basename(name)));
}

module.exports = { sendAvatar, sendUpload };
