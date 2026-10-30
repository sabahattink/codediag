/** The upstream URL a proxy request asks for. */
function requestedUrl(req) {
  return req.query.url;
}

module.exports = { requestedUrl };
