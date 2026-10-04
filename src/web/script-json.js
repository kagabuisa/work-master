'use strict';

// JSON embedded in HTML script elements must not contain a literal '<', which
// could start a closing script tag before JavaScript parses the string.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

module.exports = { scriptJson };
