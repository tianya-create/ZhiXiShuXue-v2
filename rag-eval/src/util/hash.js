const crypto = require('crypto');

function sha256OfText(text) {
  return 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256OfJson(value) {
  return sha256OfText(JSON.stringify(value));
}

module.exports = { sha256OfText, sha256OfJson };
