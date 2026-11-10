// JSON.parse does not pollute Object.prototype, but a later assignment through
// a special key still can. Reject those names while parsing.
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);

export function parseStrictJson(text) {
  return JSON.parse(String(text), (key, value) => {
    if (BLOCKED.has(key)) {
      const error = new Error('拒绝特殊字段名');
      error.code = 'local_refused';
      throw error;
    }
    return value;
  });
}
