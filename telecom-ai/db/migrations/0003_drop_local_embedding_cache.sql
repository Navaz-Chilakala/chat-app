-- local-hash embeddings are recomputed faster than they are looked up, so caching them only duplicated
-- every vector. TRUNCATE (unlike DELETE) returns the space immediately, which matters on size-capped plans.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM embedding_cache c JOIN embedding_models m ON m.id = c.model_id WHERE m.provider <> 'local-hash'
  ) THEN
    TRUNCATE embedding_cache;
  ELSE
    DELETE FROM embedding_cache c USING embedding_models m WHERE m.id = c.model_id AND m.provider = 'local-hash';
  END IF;
END $$;
