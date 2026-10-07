'use strict';

const jwt = require('jsonwebtoken');
const { parseId } = require('./logic');

// The token says only *who* you are (the user id). What you may do is read
// fresh from the database on every request -- see loadUser in app.js -- so a
// deleted account or a changed role takes effect immediately, not when the
// token happens to expire.
const signToken = (user, secret, expiresIn) =>
  jwt.sign({ username: user.username }, secret, {
    algorithm: 'HS256',
    subject: String(user.id),
    expiresIn,
  });

// Returns the user id, or null for a missing, forged, expired or malformed
// token. Pinning the algorithm stops a token from choosing its own (including
// "none", which would mean no signature at all).
const verifyToken = (token, secret) => {
  try {
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
    return parseId(claims.sub);
  } catch {
    return null;
  }
};

const bearerToken = (header = '') => {
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
};

module.exports = { signToken, verifyToken, bearerToken };
