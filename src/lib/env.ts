import "server-only";

// Server code imports env from here; `server-only` keeps secrets out of client bundles.
// (instrumentation.ts imports ./env-core directly because it runs outside React.)
export * from "./env-core";
