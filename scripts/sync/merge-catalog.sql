-- Catalog merge: staging tables -> live components / datasheet_chunks.
--
-- Run as ONE transaction:  psql -1 -v ON_ERROR_STOP=1 -f merge-catalog.sql
-- Any failed assertion raises an exception and rolls the whole merge back.
--
-- Expects stg_components and stg_datasheet_chunks (same columns as the live tables) to be loaded.
-- Touches ONLY components and datasheet_chunks: users, sessions, ai_calls, audit_log and everything
-- else are never referenced. Live component ids are preserved (matched by part_number), so nothing
-- that references a component breaks.

-- ── Pre-flight assertions: refuse to run on bad input ───────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM stg_components) = 0 THEN
    RAISE EXCEPTION 'staging is empty - refusing to merge (an empty export must never wipe the catalog)';
  END IF;
  IF (SELECT count(*) FROM stg_datasheet_chunks WHERE embedding IS NULL OR vector_dims(embedding) <> 1536) > 0 THEN
    RAISE EXCEPTION 'staged chunks with missing or wrong-dimension embeddings';
  END IF;
  IF (SELECT count(*) FROM stg_datasheet_chunks s WHERE NOT EXISTS (SELECT 1 FROM stg_components c WHERE c.id = s.component_id)) > 0 THEN
    RAISE EXCEPTION 'staged chunks reference components that are not in the export';
  END IF;
END $$;

-- ── Components: update by part_number (live id kept), insert new ones ───────────────────────────
INSERT INTO components (id, part_number, manufacturer, category, specs, datasheet_url, source, last_refreshed, embedding)
SELECT id, part_number, manufacturer, category, specs, datasheet_url, source, last_refreshed, embedding
FROM stg_components
ON CONFLICT (part_number) DO UPDATE SET
  manufacturer   = EXCLUDED.manufacturer,
  category       = EXCLUDED.category,
  specs          = EXCLUDED.specs,
  datasheet_url  = EXCLUDED.datasheet_url,
  source         = EXCLUDED.source,
  last_refreshed = EXCLUDED.last_refreshed,
  embedding      = EXCLUDED.embedding;

-- ── Chunks: replace only for components that actually have chunks in the export ─────────────────
-- (a component that failed to ingest locally and has zero chunks must not erase the live ones)
DELETE FROM datasheet_chunks
WHERE component_id IN (
  SELECT c.id
  FROM components c
  JOIN stg_components sc ON sc.part_number = c.part_number
  WHERE EXISTS (SELECT 1 FROM stg_datasheet_chunks s WHERE s.component_id = sc.id)
);

INSERT INTO datasheet_chunks (id, component_id, chunk_text, chunk_metadata, page_number, embedding)
SELECT s.id, c.id, s.chunk_text, s.chunk_metadata, s.page_number, s.embedding
FROM stg_datasheet_chunks s
JOIN stg_components sc ON sc.id = s.component_id
JOIN components c ON c.part_number = sc.part_number;

-- ── Post-merge assertions ───────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  expected_chunks int;
  merged_chunks   int;
  expected_comps  int;
  merged_comps    int;
BEGIN
  SELECT count(*) INTO expected_chunks FROM stg_datasheet_chunks;
  SELECT count(*) INTO merged_chunks
  FROM datasheet_chunks d
  JOIN components c ON c.id = d.component_id
  JOIN stg_components sc ON sc.part_number = c.part_number
  WHERE EXISTS (SELECT 1 FROM stg_datasheet_chunks s WHERE s.component_id = sc.id);
  IF merged_chunks <> expected_chunks THEN
    RAISE EXCEPTION 'chunk count mismatch after merge: live % vs exported %', merged_chunks, expected_chunks;
  END IF;

  SELECT count(*) INTO expected_comps FROM stg_components;
  SELECT count(*) INTO merged_comps FROM components c WHERE EXISTS (SELECT 1 FROM stg_components s WHERE s.part_number = c.part_number);
  IF merged_comps <> expected_comps THEN
    RAISE EXCEPTION 'component count mismatch after merge: live % vs exported %', merged_comps, expected_comps;
  END IF;

  RAISE NOTICE 'MERGE ASSERTIONS PASSED: components=%, chunks=%', merged_comps, merged_chunks;
END $$;
