import type { PGlite } from "@electric-sql/pglite";

type State = { enabled: boolean; readers: Map<string, unknown> };
const states = new WeakMap<PGlite, State>();
function state(db: PGlite) {
  let value = states.get(db);
  if (!value) {
    value = { enabled: false, readers: new Map() };
    states.set(db, value);
  }
  return value;
}

/** Cache is keyed by committed source revisions and a bounded time window. */
export function readModel<T>(
  db: PGlite,
  name: string,
  build: () => Promise<T>,
  lifetime = 60_000,
): () => Promise<T> {
  const shared = state(db);
  const existing = shared.readers.get(name);
  if (existing) return existing as () => Promise<T>;
  let cached: { revision: string; until: number; payload: T } | undefined;
  let pending: Promise<T> | undefined;
  let hydrated = false;
  async function load() {
    const revision = (
      await db.query<{ revision: string }>(
        "SELECT revision::text FROM radar_data_revision WHERE id=1",
      )
    ).rows[0].revision;
    if (!hydrated) {
      hydrated = true;
      const saved = (
        await db.query<{ revision: string; calculated_at: string; payload: T }>(
          "SELECT revision::text,calculated_at,payload FROM radar_read_models WHERE name=$1",
          [name],
        )
      ).rows[0];
      if (saved)
        cached = {
          revision: saved.revision,
          until: Date.parse(saved.calculated_at) + lifetime,
          payload: saved.payload,
        };
    }
    if (cached && cached.revision === revision && Date.now() < cached.until)
      return cached.payload;
    const started = Date.now();
    const payload = await build();
    // Keep the revision captured BEFORE computing: a concurrent update invalidates this result.
    await db.query(
      "INSERT INTO radar_read_models(name,revision,calculated_at,payload) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,calculated_at=excluded.calculated_at,payload=excluded.payload",
      [
        name,
        revision,
        new Date(started).toISOString(),
        JSON.stringify(payload),
      ],
    );
    cached = { revision, until: started + lifetime, payload };
    return payload;
  }
  const read = () => {
    if (!shared.enabled) return build();
    if (!pending)
      pending = load().finally(() => {
        pending = undefined;
      });
    return pending;
  };
  shared.readers.set(name, read);
  return read;
}

export async function enableReadModels(db: PGlite) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS radar_data_revision(id int PRIMARY KEY CHECK(id=1), revision bigint NOT NULL);
    INSERT INTO radar_data_revision VALUES(1,0) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS radar_read_models(name text PRIMARY KEY,revision bigint NOT NULL,calculated_at timestamptz NOT NULL,payload jsonb NOT NULL);
    CREATE OR REPLACE FUNCTION radar_touch_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE radar_data_revision SET revision=revision+1 WHERE id=1; RETURN NULL; END $$;
    CREATE INDEX IF NOT EXISTS coupon_items_run_product ON coupon_items(run_id,product_id);
    CREATE INDEX IF NOT EXISTS coupon_rules_latest ON coupon_rule_snapshots(product_id,observed_at DESC);
    CREATE INDEX IF NOT EXISTS coupon_tasks_brand_complete ON coupon_tasks(brand_id,completed_at DESC) WHERE state='complete';
    CREATE INDEX IF NOT EXISTS coupon_score_run_lookup ON coupon_score_history(brand_id,product_id,run_id,scored_at DESC,id DESC);
  `);
  for (const table of [
    "brands",
    "coupon_baselines",
    "coupon_tasks",
    "coupon_diffs",
    "coupon_items",
    "coupon_rule_snapshots",
    "coupon_store_snapshots",
    "coupon_dispositions",
    "brand_index_observations",
    "coupon_score_history",
  ])
    await db.exec(
      `DROP TRIGGER IF EXISTS radar_changed ON ${table}; CREATE TRIGGER radar_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION radar_touch_revision();`,
    );
  state(db).enabled = true;
}
