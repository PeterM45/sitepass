// Test stub for SvelteKit's `$env/dynamic/private` virtual module, wired in via
// vitest's alias. The real module maps to process.env under adapter-node, so the
// stub does the same — letting the sveltekit adapter read SITEPASS_* in tests.
export const env = process.env
