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

  // One constrained-JSON completion.
  async json(messages, schema, maxTokens = 320) {
    const res = await this.engine.chat.completions.create({
      messages, temperature: 0.2, max_tokens: maxTokens,
      response_format: { type: 'json_object', schema: JSON.stringify(schema) },
    });
    const txt = res.choices[0].message.content || '{}';
    try { return JSON.parse(txt); } catch { return { action: 'reply', message: txt.slice(0, 400) }; }
  }
}
