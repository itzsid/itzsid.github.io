// Free, in-browser LLM: an open model (Qwen2.5) compiled for WebGPU by MLC
// WebLLM. Weights are downloaded once, cached by the browser, and run on the
// visitor's GPU. Nothing is sent to a server.
const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm';

export const MODELS = [
  { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 3B', note: '~2.5 GB GPU memory · recommended' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 1.5B', note: '~1.6 GB · faster, weaker at multi-step tasks' },
  { id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC', name: 'Qwen2.5 7B', note: '~5 GB · strongest, needs a capable GPU' },
];

export const webgpuAvailable = () => typeof navigator !== 'undefined' && !!navigator.gpu;

export class LocalLLM {
  constructor() { this.engine = null; this.modelId = null; this.loading = false; }
  get ready() { return !!this.engine; }

  async isCached(modelId) {
    try { const w = await import(WEBLLM); return await w.hasModelInCache(modelId); } catch { return false; }
  }

  async load(modelId, onProgress) {
    if (!webgpuAvailable()) throw new Error('WebGPU is not available in this browser. Try a recent Chrome or Edge, or Safari 26.');
    if (this.loading) throw new Error('A model is already loading.');
    this.loading = true;
    try {
      const w = await import(WEBLLM);
      if (this.engine) { try { await this.engine.unload(); } catch { /* ignore */ } this.engine = null; }
      const worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
      this.engine = await w.CreateWebWorkerMLCEngine(worker, modelId, { initProgressCallback: (r) => onProgress?.(r) }, { context_window_size: 8192 });
      this.modelId = modelId;
    } finally { this.loading = false; }
  }

  // One constrained-JSON completion. Calls are serialized (one engine, one GPU
  // queue) so parallel agents never interleave requests.
  json(messages, schema, maxTokens = 256) {
    const run = async () => {
      const res = await this.engine.chat.completions.create({
        messages, temperature: 0.1, max_tokens: maxTokens,
        response_format: { type: 'json_object', schema: JSON.stringify(schema) },
      });
      return parseJSON(res.choices[0].message.content || '{}');
    };
    const p = (this.queue || Promise.resolve()).then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

// Parse model output; repair the usual small-model slips (prose around the
// object, a cut-off ending) before giving up.
export function parseJSON(txt) {
  try { return JSON.parse(txt); } catch { /* repair below */ }
  const s = txt.indexOf('{');
  if (s >= 0) {
    let body = txt.slice(s);
    const e = body.lastIndexOf('}');
    try { return JSON.parse(body.slice(0, e + 1)); } catch { /* try closing it */ }
    const close = (b) => b + ((b.match(/(?<!\\)"/g) || []).length % 2 ? '"' : '') + '}';
    try { return JSON.parse(close(body)); } catch { /* drop the cut-off field */ }
    try { return JSON.parse(close(body.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, ''))); } catch { /* fall through */ }
  }
  return { action: 'reply', message: txt.slice(0, 400) };
}
