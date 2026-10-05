// Minimal stand-in for @deepseek-ai/schemastery: a chainable no-op schema builder.
// The entry only builds the schema at load time; validation is DSH's job and is
// covered by the runtime, not by this stub.
function node() {
  const api = {
    default: () => api,
    min: () => api,
    max: () => api,
    optional: () => api,
  };
  return api;
}

const z = {
  object: () => node(),
  string: () => node(),
  number: () => node(),
  boolean: () => node(),
  dict: () => node(),
  array: () => node(),
};

export default z;
