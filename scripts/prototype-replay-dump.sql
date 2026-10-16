-- Dumps one Prototype session for scripts/prototype-replay.ts (read-only; safe on prod).
--   psql -v sid=<session id> -At -f scripts/prototype-replay-dump.sql > dump.json
with s as (
  select id, title, intent_text, design_graph from design_sessions where id = :'sid'
),
ids as (
  select distinct jsonb_array_elements_text(
    jsonb_build_array(s.design_graph -> 'controller' ->> 'hardwareEntityId')
    || coalesce((select jsonb_agg(m ->> 'hardwareEntityId') from jsonb_array_elements(s.design_graph -> 'modules') m), '[]'::jsonb)
  ) as id
  from s
)
select json_build_object(
  'session', (select row_to_json(s) from s),
  'entities', coalesce((
    select json_agg(json_build_object(
      'hardware_entity_id', e.hardware_entity_id,
      'product_family_id', e.product_family_id,
      'review_status', e.review_status,
      'lifecycle_status', e.lifecycle_status,
      'asset_readiness', e.asset_readiness,
      'scope', e.scope,
      'verification_method', e.verification_method,
      'record_origin', e.record_origin,
      'project_id', e.project_id,
      'metadata_json', e.metadata_json,
      'svg_markup', a.svg_markup,
      'svg_hash', a.generation_source_hash
    ))
    from hardware_entities e
    left join svg_assets a on a.hardware_entity_id = e.hardware_entity_id
    where e.hardware_entity_id in (select id from ids)
  ), '[]'::json)
);
