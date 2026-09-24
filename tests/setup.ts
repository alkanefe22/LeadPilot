// Deterministic env for every test file. Real keys are never needed for tests.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.ANTHROPIC_MODEL ??= "claude-test-model";
process.env.APP_URL ??= "http://localhost:3000";
