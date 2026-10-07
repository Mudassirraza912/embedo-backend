-- Route X: Prototype hardware sourcing (names real products for library gaps and extracts their
-- facts from vendor product pages). Inserted only when missing so an operator's choice survives.
INSERT INTO "model_routes" ("id", "task_case", "domain", "model_provider", "model_name", "temperature", "max_tokens", "is_active", "updated_at")
SELECT gen_random_uuid(), 'X', NULL, 'openai', 'gpt-4o', 0.00, 4096, true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "model_routes" WHERE "task_case" = 'X' AND "domain" IS NULL);
