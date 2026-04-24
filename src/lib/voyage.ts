const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3';

type VoyageResponse = {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
};

export async function embed(text: string): Promise<number[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set');

  let attempt = 0;
  while (true) {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [text], model: MODEL }),
    });

    if (res.ok) {
      const body = (await res.json()) as VoyageResponse;
      const v = body.data?.[0]?.embedding;
      if (!Array.isArray(v)) throw new Error('voyage: malformed response');
      return v;
    }

    const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (retryable && attempt < 4) {
      const backoff = Math.min(30, 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, backoff));
      attempt++;
      continue;
    }

    const errBody = await res.text();
    throw new Error(`voyage ${res.status}: ${errBody.slice(0, 300)}`);
  }
}
