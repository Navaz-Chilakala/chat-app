// Integration tests run against a dedicated database (never the dev/prod one).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://telecom:telecom@127.0.0.1:5432/telecom_ai_test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret-test-secret";
process.env.STORAGE_DRIVER = "db";
process.env.EMBEDDING_PROVIDER = "local-hash";
