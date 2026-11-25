// DeepSeek（OpenAI 兼容）客户端。不依赖任何包，用 Node 22 自带的 fetch。
export async function chat({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeoutMs, log }) {
  const url = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/chat/completions';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || 'deepseek-flash',
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.85,
        max_tokens: maxTokens || 300,
        stream: false,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('响应里没有 content');
    return content;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('模型请求超时');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
