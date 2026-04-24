'use client';

import { useState } from 'react';

type Citation = {
  ref: string;
  note_id: string;
  meeting_id: string;
  date: string;
  snippet: string;
};

type SearchResult = {
  answer: string;
  citations: Citation[];
};

export default function Home() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCitations, setOpenCitations] = useState<Set<string>>(new Set());

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setOpenCitations(new Set());
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data: SearchResult = await res.json();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleCitation(ref: string) {
    setOpenCitations((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Notestella
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Search across your meeting notes.
          </p>
        </header>

        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What did we decide about..."
            className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            autoFocus
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </div>
        )}

        {result && (
          <section className="flex flex-col gap-4">
            <div className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm leading-6 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {result.answer}
            </div>

            {result.citations.length > 0 && (
              <div className="flex flex-col gap-2">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Citations
                </h2>
                {result.citations.map((c) => {
                  const open = openCitations.has(c.ref);
                  return (
                    <div
                      key={c.ref}
                      className="rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
                    >
                      <button
                        onClick={() => toggleCitation(c.ref)}
                        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                          [{c.ref}]
                        </span>
                        <span className="ml-3 flex-1 truncate">{c.date}</span>
                        <span className="ml-3 text-xs text-zinc-400">{open ? '−' : '+'}</span>
                      </button>
                      {open && (
                        <div className="border-t border-zinc-200 px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
                          <div className="mb-2 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                            meeting {c.meeting_id}
                          </div>
                          <div className="whitespace-pre-wrap leading-6">{c.snippet}</div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
