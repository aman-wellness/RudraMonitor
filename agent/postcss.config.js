// Stop Vite from walking up to the dashboard's TS-format postcss.config.ts (which
// requires `tsx` at load time and breaks the agent build on CI). The agent's UI is
// plain CSS — no PostCSS plugins needed.
export default { plugins: {} };
