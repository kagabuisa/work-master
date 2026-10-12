'use strict';
const assert = require('node:assert/strict');
const contract = require('../../docs/api/openapi.v1.json');

// Validate the response-schema keywords used by this repository's contract.
// This is a contract regression check, not a general OpenAPI conformance tool.
function validate(schema, value, location = 'response') {
  if (schema.$ref) {
    let target = contract;
    for (const part of schema.$ref.slice(2).split('/')) target = target[part];
    return validate(target, value, location);
  }
  if (value === null && schema.nullable) return;
  if (schema.oneOf) {
    let matches = 0;
    for (const option of schema.oneOf) {
      try { validate(option, value, location); matches++; } catch (error) { if (!(error instanceof assert.AssertionError)) throw error; }
    }
    assert.equal(matches, 1, location + ' must match one documented shape'); return;
  }
  if (schema.type === 'object') {
    assert(value && typeof value === 'object' && !Array.isArray(value), location);
    for (const key of schema.required || []) assert(Object.hasOwn(value, key), `${location}.${key} required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert(Object.hasOwn(schema.properties, key), `${location}.${key} undocumented`);
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    assert(Array.isArray(value), location);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, location);
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, location);
    value.forEach((item, index) => validate(schema.items, item, `${location}[${index}]`));
  } else if (schema.type === 'integer') {
    assert(Number.isInteger(value), location);
    if (schema.minimum !== undefined) assert(value >= schema.minimum, location);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, location);
  } else if (schema.type) {
    assert.equal(typeof value, schema.type, location);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), location);
    if (schema.maxLength !== undefined) assert(value.length <= schema.maxLength, location);
    if (schema.minLength !== undefined) assert(value.length >= schema.minLength, location);
  }
  if (schema.enum) assert(schema.enum.includes(value), location);
}

function validateResponse(path, method, status, body) {
  const segments = path.split('?')[0].split('/');
  const resource = Object.keys(contract.paths).find(candidate => {
    const parts = candidate.split('/');
    return parts.length === segments.length && parts.every((part, index) => part === segments[index] || /^\{.+\}$/.test(part));
  });
  assert(resource && contract.paths[resource][method], path + ' must be documented');
  let response = contract.paths[resource][method].responses[String(status)];
  assert(response, path + ' status must be documented');
  if (response.$ref) response = contract.components.responses[response.$ref.split('/').pop()];
  validate(response.content['application/json'].schema, body, path);
}
const validateRead = (path, status, body) => validateResponse(path, 'get', status, body);
module.exports = { validateRead, validateResponse };
