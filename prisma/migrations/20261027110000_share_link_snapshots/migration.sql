ALTER TABLE "share_links"
  ADD COLUMN "artifact_key" VARCHAR(32),
  ADD COLUMN "snapshot" JSONB;

ALTER TABLE "share_links"
  ADD CONSTRAINT "share_links_artifact_key_check"
  CHECK (
    "artifact_key" IS NULL
    OR "artifact_key" IN ('fbd', 'power', 'protocol', 'prototypeDiagram')
  );
