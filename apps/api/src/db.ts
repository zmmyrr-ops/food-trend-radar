import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { initCoupons } from "./coupons.js";
export async function openDatabase(directory?: string) {
  if (directory) await mkdir(directory, { recursive: true });
  // Avoid recycling WAL files through filesystem renames in the local WASM store.
  const db = new PGlite(directory, {
    startParams: [...PGlite.defaultStartParams, "-c", "wal_recycle=off"],
  });
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version int primary key, applied_at timestamptz not null default now());",
  );
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=1"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`
 CREATE TABLE brands(id uuid primary key,name text not null,name_key text not null unique,category text not null,aliases jsonb not null default '[]',shanghai_evidence_url text not null,active boolean not null default true,region_code text not null default '310000' check(region_code='310000'),created_at timestamptz not null default now());
 CREATE TABLE events(id uuid primary key,brand_id uuid not null references brands(id),title text not null,type text not null,starts_at timestamptz not null,ends_at timestamptz not null check(ends_at>starts_at),source_url text not null,evidence_note text not null,effective_price numeric(12,2) check(effective_price>=0),eligibility text not null,status text not null,dedup_key text not null unique,region_code text not null default '310000' check(region_code='310000'),created_at timestamptz not null default now());
 CREATE INDEX events_brand_start ON events(brand_id,starts_at);
 CREATE TABLE changes(id bigint generated always as identity primary key,entity_type text not null,entity_id uuid not null,snapshot jsonb not null,created_at timestamptz not null default now());
 CREATE TABLE imports(id uuid primary key,idempotency_key text not null unique,body_hash text not null,result jsonb not null,created_at timestamptz not null default now());
 INSERT INTO schema_migrations(version) VALUES(1);`);
    });
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=2"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`CREATE TABLE data_sources(id uuid primary key, name_key text not null unique, config jsonb not null, created_at timestamptz not null default now());
        INSERT INTO schema_migrations(version) VALUES(2);`);
    });
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=3"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`ALTER TABLE brands ADD COLUMN keywords jsonb NOT NULL DEFAULT '[]',
        ADD COLUMN revision integer NOT NULL DEFAULT 1,
        ADD COLUMN review_status text NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','verified','rejected')),
        ADD COLUMN review_note text, ADD COLUMN reviewed_by text, ADD COLUMN reviewed_at timestamptz;
      ALTER TABLE events ADD COLUMN source_id uuid REFERENCES data_sources(id);
      CREATE INDEX events_source ON events(source_id);
      INSERT INTO schema_migrations(version) VALUES(3);`);
    });
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=4"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`CREATE TABLE source_audits(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES data_sources(id),source_hash text NOT NULL,config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
        CREATE TABLE source_trials(id uuid PRIMARY KEY,audit_id uuid NOT NULL REFERENCES source_audits(id),day date NOT NULL,config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(audit_id,day));
        CREATE TABLE event_admissions(id uuid PRIMARY KEY,event_id uuid NOT NULL REFERENCES events(id),config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX event_admissions_latest ON event_admissions(event_id,created_at DESC);
        CREATE TABLE policy_reviews(id uuid PRIMARY KEY,policy_hash text NOT NULL,config jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO schema_migrations(version) VALUES(4);`);
    });
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=5"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`CREATE TABLE brand_research(id text PRIMARY KEY, brand_id uuid NOT NULL REFERENCES brands(id),evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX brand_research_brand ON brand_research(brand_id);
        INSERT INTO schema_migrations(version) VALUES(5);`);
    });
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=6"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`ALTER TABLE events
        ADD COLUMN original_price numeric(12,2) CHECK(original_price >= 0 AND original_price <= 100000),
        ADD COLUMN promotion_terms text NOT NULL DEFAULT '',
        ADD COLUMN collaboration text NOT NULL DEFAULT '',
        ADD COLUMN store_scope text NOT NULL DEFAULT 'unknown' CHECK(store_scope IN ('unknown','all_shanghai','selected')),
        ADD COLUMN applicable_stores jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(applicable_stores)='array');
        INSERT INTO schema_migrations(version) VALUES(6);`);
    });
  if (
    !(await db.query("SELECT version FROM schema_migrations WHERE version=7"))
      .rows.length
  )
    await db.transaction(async (tx) => {
      await tx.exec(`CREATE TABLE auto_runs(id uuid PRIMARY KEY,status text NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,result jsonb,error text);
        CREATE TABLE auto_signals(id text PRIMARY KEY,brand_id uuid NOT NULL REFERENCES brands(id),source_id text NOT NULL,url text NOT NULL,payload jsonb NOT NULL,content_hash text NOT NULL,first_seen_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL);
        CREATE TABLE auto_signal_revisions(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,signal_id text NOT NULL REFERENCES auto_signals(id),run_id uuid NOT NULL REFERENCES auto_runs(id),payload jsonb NOT NULL,content_hash text NOT NULL,available_at timestamptz NOT NULL);
        CREATE TABLE auto_scores(run_id uuid NOT NULL REFERENCES auto_runs(id),brand_id uuid NOT NULL REFERENCES brands(id),as_of timestamptz NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(run_id,brand_id));
        CREATE INDEX auto_signal_brand ON auto_signals(brand_id,last_seen_at);
        CREATE INDEX auto_runs_time ON auto_runs(started_at DESC);
        INSERT INTO schema_migrations(version) VALUES(7);`);
    });
  await initCoupons(db);
  return db;
}
