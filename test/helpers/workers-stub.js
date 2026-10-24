// Lets tests import Durable Object classes under plain Node: `cloudflare:workers` is resolved to
// a stub base class, and the WebSocket pair globals the room uses are faked.
import { register } from 'node:module';

const stub = 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,${encodeURIComponent(stub)}', shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

globalThis.WebSocketRequestResponsePair ??= class { constructor(a, b) { this.a = a; this.b = b; } };

// A Durable Object context with in-memory storage and no sockets.
export function fakeCtx() {
  const store = new Map();
  let alarm = null;
  return {
    storage: {
      get: async (k) => structuredClone(store.get(k)),
      put: async (k, v) => void store.set(k, structuredClone(v)),
      getAlarm: async () => alarm,
      setAlarm: async (t) => void (alarm = t),
      deleteAlarm: async () => void (alarm = null),
    },
    setWebSocketAutoResponse() {},
    blockConcurrencyWhile: (fn) => fn(),
    getWebSockets: () => [],
    acceptWebSocket() {},
  };
}
