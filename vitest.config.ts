import { defineConfig } from "vitest/config";

// Minimal vitest setup — proof of life.
//
// Plain Node test runner. Pure helpers (currency mapping, Zod schemas, error
// classifiers) don't need the Workers runtime.
//
// When we start testing Workers-specific behaviour (Durable Objects, KV,
// fetch interception inside the same isolate), add `@cloudflare/vitest-pool-workers`
// and a Workers pool entry. For now the cost outweighs the benefit.
//
// MSW (Mock Service Worker) for outbound fetch mocking is also NOT installed yet
// — add it when the first integration test needs it (first composite F2B
// invoice tool in slice 2).
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
