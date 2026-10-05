// Test loader hook: lets the test suite import lib/index.js without the DSH runtime.
// Only the three DSH-provided specifiers are redirected; everything else resolves normally.
const STUBS = {
  "@deepseek-ai/dsh-tools": "./dsh-tools-stub.mjs",
  "@deepseek-ai/dsh-mcp-client": "./dsh-mcp-client-stub.mjs",
  "@deepseek-ai/schemastery": "./schemastery-stub.mjs",
};

export async function resolve(specifier, context, nextResolve) {
  const stub = STUBS[specifier];
  if (stub) {
    return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
