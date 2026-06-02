// Prevent Vite from walking up to the parent web project's postcss.config.ts
// (which requires ts-node). Mobile app uses plain inline styles — no PostCSS.
export default { plugins: [] };
