import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  splitSqlStatements,
  cleanIdentifier,
  isTypeNarrowed,
  isSqlMigrationCandidate,
  parseSqlFacts,
  diffSqlFacts,
  SQL_RECOMMENDED_RULES
} from "../tools/facts-sql.mjs";
import { extractFacts, isDevComposeFile } from "../tools/facts.mjs";
import { diffFacts } from "../tools/facts-diff.mjs";
import { discoverFiles } from "../tools/scan.mjs";
import { evaluateRules, getExitCode, formatMarkdownReport } from "../tools/rules.mjs";
import { RECOMMENDED_RULES } from "../tools/rules-recommended.mjs";

const CLI = path.resolve("tools/cli.mjs");

// 1. Splitter with quotes, comments, $$ bodies, and block-comment whitespace
test("splitter respects quotes, backticks, comments, and $$ dollar-quoted bodies", () => {
  const sql = `
    -- Line comment with ; semicolon
    /* Block comment with ; semicolon and
       multiple lines */
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      note TEXT DEFAULT 'hello; world',
      "quoted;col" VARCHAR(50),
      \`backtick;col\` INT
    );

    -- Function with dollar-quoted body containing semicolons
    CREATE OR REPLACE FUNCTION audit_func() RETURNS void AS $$
    BEGIN
      INSERT INTO audit_log (msg) VALUES ('test; 1');
      INSERT INTO audit_log (msg) VALUES ('test; 2');
    END;
    $$ LANGUAGE plpgsql;

    /* Tagged dollar quote */
    CREATE FUNCTION tagged_func() AS $body$
      SELECT 1;
      SELECT 2;
    $body$;

    DROP TABLE IF EXISTS old_users;
  `;

  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 4, `Expected 4 statements, got ${statements.length}`);

  // 1. CREATE TABLE
  assert.ok(statements[0].text.startsWith("CREATE TABLE users"));
  assert.ok(statements[0].text.includes("'hello; world'"));
  assert.ok(statements[0].text.includes('"quoted;col"'));
  assert.ok(statements[0].text.includes("`backtick;col`"));

  // 2. $$ function
  assert.ok(statements[1].text.includes("audit_func()"));
  assert.ok(statements[1].text.includes("INSERT INTO audit_log"));

  // 3. $body$ function
  assert.ok(statements[2].text.includes("tagged_func()"));
  assert.ok(statements[2].text.includes("SELECT 1;"));

  // 4. DROP TABLE
  assert.equal(statements[3].text, "DROP TABLE IF EXISTS old_users");
});

// 1b. Block comments are normalized to a space so hidden keywords still parse
test("block comments collapse to a space so DROP/**/TABLE and DROP /* x */ TABLE match DROP TABLE", () => {  const hiddenDrop = splitSqlStatements("DROP/**/TABLE orders;");
  assert.equal(hiddenDrop.length, 1);
  assert.equal(hiddenDrop[0].text, "DROP TABLE orders");
  assert.notStrictEqual(hiddenDrop[0].text, "DROPTABLE orders");

  const spacedDrop = splitSqlStatements("DROP /* x */ TABLE orders;");
  assert.equal(spacedDrop.length, 1);
  assert.equal(spacedDrop[0].text, "DROP  TABLE orders");
  assert.notStrictEqual(spacedDrop[0].text, "DROPTABLE orders");
  assert.notStrictEqual(spacedDrop[0].text, "DROP TABLE orders");

  const plainDrop = splitSqlStatements("DROP TABLE orders;");
  assert.equal(plainDrop.length, 1);
  assert.equal(plainDrop[0].text, "DROP TABLE orders");

  // The hidden/spaced drops produce the same parsed table entity as the plain drop
  const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE orders (id int);" }]);
  const headHidden = extractFacts([
    { path: "migrations/001.sql", content: "CREATE TABLE orders (id int);" },
    { path: "migrations/002.sql", content: "DROP/**/TABLE orders;" }
  ]);
  const headSpaced = extractFacts([
    { path: "migrations/001.sql", content: "CREATE TABLE orders (id int);" },
    { path: "migrations/002.sql", content: "DROP /* x */ TABLE orders;" }
  ]);
  const headPlain = extractFacts([
    { path: "migrations/001.sql", content: "CREATE TABLE orders (id int);" },
    { path: "migrations/002.sql", content: "DROP TABLE orders;" }
  ]);
  const diffHidden = diffFacts(base, headHidden);
  const diffSpaced = diffFacts(base, headSpaced);
  const diffPlain = diffFacts(base, headPlain);
  assert.equal(diffHidden.events.some(e => e.type === "sql.drop_table"), true);
  assert.equal(diffSpaced.events.some(e => e.type === "sql.drop_table"), true);
  assert.equal(diffPlain.events.some(e => e.type === "sql.drop_table"), true);
  assert.equal(diffHidden.events.filter(e => e.type === "sql.drop_table").length, diffPlain.events.filter(e => e.type === "sql.drop_table").length);
  assert.equal(diffSpaced.events.filter(e => e.type === "sql.drop_table").length, diffPlain.events.filter(e => e.type === "sql.drop_table").length);
});

// 2. Each statement type
test("each statement type updates entities and emits expected events", () => {
  // A. CREATE TABLE (columns: name, type, NOT NULL, DEFAULT present, PRIMARY KEY, UNIQUE)
  {
    const sql = `
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(64) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price DECIMAL(10, 2) DEFAULT 0.00 NOT NULL,
        is_active BOOLEAN DEFAULT true,
        CONSTRAINT uq_name UNIQUE (name)
      );
    `;
    const facts = extractFacts([{ path: "migrations/001_create.sql", content: sql }]);
    const table = facts.entities.find(e => e.id === "db.table:products");
    assert.ok(table, "Table entity not found");
    assert.equal(table.name, "products");

    const idCol = facts.entities.find(e => e.id === "db.column:products.id");
    assert.ok(idCol);
    assert.equal(idCol.attrs.primaryKey, true);
    assert.equal(idCol.attrs.notNull, true);
    assert.equal(idCol.attrs.hasDefault, true);

    const skuCol = facts.entities.find(e => e.id === "db.column:products.sku");
    assert.ok(skuCol);
    assert.equal(skuCol.attrs.unique, true);
    assert.equal(skuCol.attrs.notNull, true);
    assert.equal(skuCol.attrs.hasDefault, false);

    const nameCol = facts.entities.find(e => e.id === "db.column:products.name");
    assert.ok(nameCol);
    assert.equal(nameCol.attrs.unique, true); // table constraint UNIQUE (name)

    const priceCol = facts.entities.find(e => e.id === "db.column:products.price");
    assert.ok(priceCol);
    assert.equal(priceCol.attrs.hasDefault, true);
    assert.equal(priceCol.attrs.notNull, true);
  }

  // B. DROP TABLE
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE temp_logs (id int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE temp_logs (id int);" },
      { path: "migrations/002.sql", content: "DROP TABLE temp_logs;" }
    ]);
    assert.equal(head.entities.some(e => e.id === "db.table:temp_logs"), false);

    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.drop_table" && e.before === "temp_logs"));
    assert.ok(diff.events.some(e => e.type === "entity.removed" && e.entityId === "db.table:temp_logs"));
  }

  // C. ALTER TABLE ... ADD/DROP COLUMN
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE items (id int, old_col text);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE items (id int, old_col text);" },
      { path: "migrations/002.sql", content: "ALTER TABLE items ADD COLUMN new_col int, DROP COLUMN old_col;" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.drop_column" && e.before === "items.old_col"));
    assert.ok(diff.events.some(e => e.type === "db.field_removed" && e.entityId === "db.column:items.old_col"));
    assert.ok(head.entities.some(e => e.id === "db.column:items.new_col"));
  }

  // D. ALTER COLUMN TYPE / SET DATA TYPE / SET NOT NULL / DROP NOT NULL (Postgres)
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE customers (id int, bio text, score int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE customers (id int, bio text, score int);" },
      {
        path: "migrations/002.sql",
        content: `
          ALTER TABLE customers ALTER COLUMN bio TYPE varchar(255);
          ALTER TABLE customers ALTER COLUMN score SET NOT NULL;
          ALTER TABLE customers ALTER COLUMN bio DROP NOT NULL;
          ALTER TABLE customers ALTER COLUMN score SET DEFAULT 10;
        `
      }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.type_narrowed" && e.before === "text" && e.after === "varchar(255)"));
    assert.ok(diff.events.some(e => e.type === "sql.not_null_without_default" && e.after === "NOT NULL"));
    assert.ok(diff.events.some(e => e.type === "db.field_type_changed"));
    assert.ok(diff.events.some(e => e.type === "db.field_made_required"));
  }

  // E. MODIFY / CHANGE COLUMN (MySQL)
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE users (id int, bio text, age int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE users (id int, bio text, age int);" },
      {
        path: "migrations/002.sql",
        content: `
          ALTER TABLE users MODIFY COLUMN bio varchar(100) NOT NULL;
          ALTER TABLE users CHANGE COLUMN age years_old bigint;
        `
      }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.type_narrowed" && e.before === "text" && e.after === "varchar(100)"));
    assert.ok(diff.events.some(e => e.type === "sql.rename" && e.before === "users.age" && e.after === "users.years_old"));
  }

  // F. RENAME TABLE / COLUMN
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE tbl1 (id int, col1 text);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE tbl1 (id int, col1 text);" },
      {
        path: "migrations/002.sql",
        content: `
          ALTER TABLE tbl1 RENAME COLUMN col1 TO col2;
          ALTER TABLE tbl1 RENAME TO tbl2;
        `
      }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.rename" && e.before === "tbl1.col1" && e.after === "tbl1.col2"));
    assert.ok(diff.events.some(e => e.type === "sql.rename" && e.before === "tbl1" && e.after === "tbl2"));
    assert.ok(head.entities.some(e => e.id === "db.table:tbl2"));
    assert.ok(head.entities.some(e => e.id === "db.column:tbl2.col2"));
  }

  // G. CREATE [UNIQUE] INDEX [CONCURRENTLY], DROP INDEX, ADD CONSTRAINT ... [NOT VALID]
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE accounts (id int, email text);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE accounts (id int, email text);" },
      {
        path: "migrations/002.sql",
        content: `
          -- Creating on existing table without concurrently triggers warning
          CREATE INDEX idx_accounts_email ON accounts (email);
          -- Concurrent index should not trigger warning
          CREATE INDEX CONCURRENTLY idx_accounts_id ON accounts (id);
          -- Creating index on table created in same file should not trigger warning
          CREATE TABLE new_tbl (id int);
          CREATE INDEX idx_new ON new_tbl (id);
          DROP INDEX idx_old;
          ALTER TABLE accounts ADD CONSTRAINT check_id CHECK (id > 0) NOT VALID;
        `
      }
    ]);
    const diff = diffFacts(base, head);
    const indexWarning = diff.events.filter(e => e.type === "sql.index_without_concurrently");
    assert.equal(indexWarning.length, 1, `Expected 1 index warning, got ${indexWarning.length}`);
    assert.equal(indexWarning[0].entityId, "db.table:accounts");
  }
});

// 3. Postgres and MySQL dialect variants
test("PostgreSQL and MySQL dialect variations are parsed accurately", () => {
  // Postgres dialect
  const pgSql = `
    CREATE TABLE pg_table (
      id BIGSERIAL PRIMARY KEY,
      uuid_col UUID NOT NULL,
      payload JSONB DEFAULT '{}',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      is_active BOOLEAN DEFAULT FALSE
    );
  `;
  const pgFacts = extractFacts([{ path: "migrations/001_pg.sql", content: pgSql }]);
  assert.equal(pgFacts.errors.length, 0);
  const uuidCol = pgFacts.entities.find(e => e.id === "db.column:pg_table.uuid_col");
  assert.ok(uuidCol);
  assert.equal(uuidCol.attrs.type, "uuid");
  assert.equal(uuidCol.attrs.notNull, true);

  // MySQL dialect
  const mySql = `
    CREATE TABLE \`my_table\` (
      \`id\` INT(11) AUTO_INCREMENT PRIMARY KEY,
      \`status\` ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
      \`description\` LONGTEXT,
      \`flag\` TINYINT(1) DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    RENAME TABLE \`my_table\` TO \`my_table_v2\`;
  `;
  const myFacts = extractFacts([{ path: "migrations/001_mysql.sql", content: mySql }]);
  assert.equal(myFacts.errors.length, 0);
  assert.ok(myFacts.entities.some(e => e.id === "db.table:my_table_v2"));
  const flagCol = myFacts.entities.find(e => e.id === "db.column:my_table_v2.flag");
  assert.ok(flagCol);
  assert.equal(flagCol.attrs.hasDefault, true);
});

// 4. Ordering V2 < V10 natural path sorting
test("ordering V2 < V10 via natural path sorting", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sql-order-test-"));
  try {
    const migDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migDir, { recursive: true });

    // Create files such that alphabetical sort would order V10 before V2
    fs.writeFileSync(path.join(migDir, "V1__init.sql"), "CREATE TABLE t (id int);");
    fs.writeFileSync(path.join(migDir, "V2__add_col.sql"), "ALTER TABLE t ADD COLUMN v2_col text;");
    fs.writeFileSync(path.join(migDir, "V10__add_col.sql"), "ALTER TABLE t ADD COLUMN v10_col text;");

    const discovered = discoverFiles(tmpDir);
    const sqlFiles = discovered.files.filter(f => f.path.endsWith(".sql"));
    assert.equal(sqlFiles.length, 3);

    const basenames = sqlFiles.map(f => path.basename(f.path));
    assert.deepEqual(basenames, ["V1__init.sql", "V2__add_col.sql", "V10__add_col.sql"]);

    // Extract facts and verify replay order
    const facts = extractFacts(sqlFiles);
    assert.ok(facts.entities.some(e => e.id === "db.column:t.v2_col"));
    assert.ok(facts.entities.some(e => e.id === "db.column:t.v10_col"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 5. Each event type produced from a base/head pair of migration dirs
test("each event type produced from a base/head pair of migration dirs", () => {
  // 1. sql.drop_table
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t1 (id int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE t1 (id int);" },
      { path: "migrations/002.sql", content: "DROP TABLE t1;" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.drop_table"));
    assert.ok(diff.events.some(e => e.type === "entity.removed" && e.kind === "db.table"));
  }

  // 2. sql.drop_column
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t1 (id int, c1 text);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE t1 (id int, c1 text);" },
      { path: "migrations/002.sql", content: "ALTER TABLE t1 DROP COLUMN c1;" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.drop_column"));
    assert.ok(diff.events.some(e => e.type === "db.field_removed"));
  }

  // 3. sql.type_narrowed
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t1 (id bigint);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE t1 (id bigint);" },
      { path: "migrations/002.sql", content: "ALTER TABLE t1 ALTER COLUMN id TYPE int;" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.type_narrowed"));
    assert.ok(diff.events.some(e => e.type === "db.field_type_changed"));
  }

  // 4. sql.not_null_without_default
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t1 (id int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE t1 (id int);" },
      { path: "migrations/002.sql", content: "ALTER TABLE t1 ADD COLUMN req_col text NOT NULL;" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.not_null_without_default"));
  }

  // 5. sql.index_without_concurrently
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t1 (id int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE t1 (id int);" },
      { path: "migrations/002.sql", content: "CREATE INDEX idx_t1_id ON t1 (id);" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.index_without_concurrently"));
  }

  // 6. sql.rename
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE old_tbl (id int);" }]);
    const head = extractFacts([
      { path: "migrations/001.sql", content: "CREATE TABLE old_tbl (id int);" },
      { path: "migrations/002.sql", content: "ALTER TABLE old_tbl RENAME TO new_tbl;" }
    ]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.rename"));
  }

  // 7. sql.migration_edited
  {
    const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t (id int);" }]);
    const head = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t (id int, extra text);" }]);
    const diff = diffFacts(base, head);
    assert.ok(diff.events.some(e => e.type === "sql.migration_edited"));
  }
});

// 6. New field with default does NOT emit made_required (it has a default)
test("new field with default does not emit made_required", () => {
  const base = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n}\n" }]);
  const head = extractFacts([{ path: "schema.prisma", content: "model User {\n  id Int @id\n  name String @default(\"hello\")\n}\n" }]);
  const diff = diffFacts(base, head);
  const madeRequired = diff.events.filter(e => e.type === "db.field_made_required");
  assert.equal(madeRequired.length, 0, "New field with default should NOT emit db.field_made_required");
});

// 7. Edited old migration -> hard finding via `archtour check`
test("edited old migration produces hard finding and exit code 1 via archtour check", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sql-check-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "sql-check-head-"));

  try {
    const baseMigDir = path.join(tmpBase, "migrations");
    const headMigDir = path.join(tmpHead, "migrations");
    fs.mkdirSync(baseMigDir, { recursive: true });
    fs.mkdirSync(headMigDir, { recursive: true });

    // Base migration file
    fs.writeFileSync(path.join(baseMigDir, "V1__init.sql"), "CREATE TABLE users (id int, email text);");

    // Head branch edits the already-applied V1 migration (history rewrite!)
    fs.writeFileSync(path.join(headMigDir, "V1__init.sql"), "CREATE TABLE users (id int, email text, extra_field text);");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit code 1 for hard finding, got ${r.status}. Stderr: ${r.stderr}`);

    const result = JSON.parse(r.stdout);
    assert.equal(result.verdict, "failed");
    assert.ok(result.summary.hard >= 1, "Expected at least 1 hard finding");

    const hardFinding = result.findings.find(f => f.ruleId === "sql-no-migration-edited");
    assert.ok(hardFinding, "sql-no-migration-edited rule did not fire");
    assert.equal(hardFinding.level, "hard");
    assert.equal(hardFinding.event.type, "sql.migration_edited");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 8. A 5,000-statement migration set parses in < 2 s
test("a 5,000-statement migration set parses in < 2 s", () => {
  const statements = [];
  for (let i = 1; i <= 2500; i++) {
    statements.push(`CREATE TABLE entity_${i} (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    statements.push(`ALTER TABLE entity_${i} ADD COLUMN extra_${i} INT DEFAULT 0;`);
  }
  const bigSql = statements.join("\n");

  const t0 = performance.now();
  const facts = extractFacts([{ path: "migrations/big_migration.sql", content: bigSql }]);
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  assert.equal(facts.entities.filter(e => e.kind === "db.table").length, 2500);
  assert.ok(elapsedMs < 2000, `Expected 5,000 statements in < 2000 ms, took ${elapsedMs.toFixed(1)} ms`);
});

// 7. Edited old migration -> hard finding via `archtour check`
test("edited old migration produces hard finding and exit code 1 via archtour check", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sql-check-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "sql-check-head-"));

  try {
    const baseMigDir = path.join(tmpBase, "migrations");
    const headMigDir = path.join(tmpHead, "migrations");
    fs.mkdirSync(baseMigDir, { recursive: true });
    fs.mkdirSync(headMigDir, { recursive: true });

    // Base migration file
    fs.writeFileSync(path.join(baseMigDir, "V1__init.sql"), "CREATE TABLE users (id int, email text);");

    // Head branch edits the already-applied V1 migration (history rewrite!)
    fs.writeFileSync(path.join(headMigDir, "V1__init.sql"), "CREATE TABLE users (id int, email text, extra_field text);");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit code 1 for hard finding, got ${r.status}. Stderr: ${r.stderr}`);

    const result = JSON.parse(r.stdout);
    assert.equal(result.verdict, "failed");
    assert.ok(result.summary.hard >= 1, "Expected at least 1 hard finding");

    const hardFinding = result.findings.find(f => f.ruleId === "sql-no-migration-edited");
    assert.ok(hardFinding, "sql-no-migration-edited rule did not fire");
    assert.equal(hardFinding.level, "hard");
    assert.equal(hardFinding.event.type, "sql.migration_edited");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// 7. A 5,000-statement migration set parses in < 2 s
test("a 5,000-statement migration set parses in < 2 s", () => {
  const statements = [];
  for (let i = 1; i <= 2500; i++) {
    statements.push(`CREATE TABLE entity_${i} (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );`);
    statements.push(`ALTER TABLE entity_${i} ADD COLUMN extra_${i} INT DEFAULT 0;`);
  }
  const bigSql = statements.join("\n");

  const t0 = performance.now();
  const facts = extractFacts([{ path: "migrations/big_migration.sql", content: bigSql }]);
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  assert.equal(facts.entities.filter(e => e.kind === "db.table").length, 2500);
  assert.ok(elapsedMs < 2000, `Expected 5,000 statements in < 2000 ms, took ${elapsedMs.toFixed(1)} ms`);
});

// 8. Deduplication: drop-column migration produces exactly one finding, level = max of pair, alsoMatched lists generic rule
test("drop-column migration produces exactly one finding for that column, level = max of pair, alsoMatched lists generic rule", () => {
  const baseFiles = [
    {
      path: "migrations/001.sql",
      content: "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255));"
    }
  ];
  const headFiles = [
    {
      path: "migrations/001.sql",
      content: "CREATE TABLE users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255));"
    },
    {
      path: "migrations/002.sql",
      content: "ALTER TABLE users DROP COLUMN name;"
    }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  // Default recommended rules: both sql-no-drop-column and no-db-field-removed are soft
  const { findings } = evaluateRules(RECOMMENDED_RULES, diff, baseFacts, headFacts);

  // Exactly one finding for users.name
  const nameFindings = findings.filter(
    f => f.event?.entityId === "db.column:users.name" || f.event?.before === "users.name"
  );
  assert.equal(nameFindings.length, 1, `Expected exactly 1 finding for users.name, got ${nameFindings.length}`);

  const f = nameFindings[0];
  assert.equal(f.ruleId, "sql-no-drop-column", "Kept rule must be the more specific sql.* rule");
  assert.equal(f.level, "soft");
  assert.ok(Array.isArray(f.alsoMatched), "alsoMatched must be an array");
  assert.ok(f.alsoMatched.includes("no-db-field-removed"), "alsoMatched must list generic rule id no-db-field-removed");
  assert.ok(f.message.includes("Column 'users.name' was dropped"));
  assert.equal(f.detail, "Column 'users.name' was dropped");

  // Test level = max of pair: custom rules where generic is hard and specific is soft -> level becomes hard
  const customRules1 = [
    { id: "no-db-field-removed", on: "db.field_removed", level: "hard" },
    { id: "sql-no-drop-column", on: "sql.drop_column", level: "soft" }
  ];
  const res1 = evaluateRules(customRules1, diff, baseFacts, headFacts);
  const nameFindings1 = res1.findings.filter(
    f => f.event?.entityId === "db.column:users.name" || f.event?.before === "users.name"
  );
  assert.equal(nameFindings1.length, 1);
  assert.equal(nameFindings1[0].ruleId, "sql-no-drop-column");
  assert.equal(nameFindings1[0].level, "hard", "Level should be max (hard) when generic is hard and specific is soft");
  assert.ok(nameFindings1[0].alsoMatched.includes("no-db-field-removed"));

  // Test level = max of pair: custom rules where generic is warn and specific is hard -> level remains hard
  const customRules2 = [
    { id: "no-db-field-removed", on: "db.field_removed", level: "warn" },
    { id: "sql-no-drop-column", on: "sql.drop_column", level: "hard" }
  ];
  const res2 = evaluateRules(customRules2, diff, baseFacts, headFacts);
  const nameFindings2 = res2.findings.filter(
    f => f.event?.entityId === "db.column:users.name" || f.event?.before === "users.name"
  );
  assert.equal(nameFindings2.length, 1);
  assert.equal(nameFindings2[0].ruleId, "sql-no-drop-column");
  assert.equal(nameFindings2[0].level, "hard", "Level should be max (hard) when generic is warn and specific is hard");
  assert.ok(nameFindings2[0].alsoMatched.includes("no-db-field-removed"));
});

// 9. ALTER TABLE sub-clauses (DROP CONSTRAINT/INDEX/DEFAULT/NOT NULL, ADD CONSTRAINT/PRIMARY KEY/FOREIGN KEY) are NOT treated as column ops
test("ALTER TABLE DROP CONSTRAINT/INDEX/DEFAULT/NOT NULL and ADD CONSTRAINT/PRIMARY KEY/FOREIGN KEY do not produce column drop events", () => {
  const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE doc_audit (id int, doc_ref text, doc_id int);" }]);
  const head = extractFacts([
    { path: "migrations/001.sql", content: "CREATE TABLE doc_audit (id int, doc_ref text, doc_id int);" },
    {
      path: "migrations/002.sql",
      content: `
        ALTER TABLE doc_audit DROP CONSTRAINT doc_audit_doc_ref_fkey;
        ALTER TABLE doc_audit DROP CONSTRAINT doc_audit_doc_id_fkey;
        ALTER TABLE doc_audit DROP INDEX idx_doc_audit_created;
        ALTER TABLE doc_audit DROP COLUMN doc_ref;
        ALTER TABLE doc_audit DROP DEFAULT;
        ALTER TABLE doc_audit ALTER COLUMN doc_ref DROP NOT NULL;
        ALTER TABLE doc_audit ADD CONSTRAINT uq_doc_ref UNIQUE (doc_ref);
        ALTER TABLE doc_audit ADD PRIMARY KEY (id);
        ALTER TABLE doc_audit ADD FOREIGN KEY (doc_id) REFERENCES other_table (id);
      `
    }
  ]);
  const diff = diffFacts(base, head);
  // Only the explicit DROP COLUMN should produce a column drop event
  const colDrops = diff.events.filter(e => e.type === "sql.drop_column");
  assert.equal(colDrops.length, 1, `Expected 1 column drop (doc_ref), got ${colDrops.length}`);
  assert.equal(colDrops[0].before, "doc_audit.doc_ref", "Column drop should be for doc_audit.doc_ref");
  // No column drop events from DROP CONSTRAINT/INDEX/DEFAULT/NOT NULL/ADD CONSTRAINT/PRIMARY KEY/FOREIGN KEY
  assert.ok(diff.events.every(e => e.type !== "sql.drop_column" || e.before === "doc_audit.doc_ref"),
    "No column drops from DROP CONSTRAINT/INDEX/DEFAULT/NOT NULL/ADD CONSTRAINT/PRIMARY KEY/FOREIGN KEY");
});

// 10. MySQL bare DROP and DROP COLUMN correctly distinguished: DROP INDEX/KEY/PRIMARY KEY/FOREIGN KEY/CHECK are not column ops, DROP COLUMN is
test("MySQL ALTER TABLE: DROP INDEX/KEY/PRIMARY KEY/FOREIGN KEY/CHECK are not column ops; DROP COLUMN is; multiple comma-separated sub-clauses handled individually", () => {
  const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE mytable (id int, a text, b text, c text);" }]);
  const head = extractFacts([
    { path: "migrations/001.sql", content: "CREATE TABLE mytable (id int, a text, b text, c text);" },
    {
      path: "migrations/002.sql",
      content: `
        ALTER TABLE mytable DROP INDEX idx_a, DROP KEY idx_b, DROP PRIMARY KEY, DROP FOREIGN KEY fk_c, DROP CHECK chk_a, DROP COLUMN a;
      `
    }
  ]);
  const diff = diffFacts(base, head);
  const colDrops = diff.events.filter(e => e.type === "sql.drop_column");
  assert.equal(colDrops.length, 1, "Exactly one column drop (a) from comma-separated sub-clauses");
  assert.equal(colDrops[0].before, "mytable.a");
  assert.ok(diff.events.some(e => e.type === "db.field_removed"), "db.field_removed also emitted for the dropped column");
  // No events for the constraint/index drops
  assert.equal(diff.events.filter(e => e.type === "sql.drop_column" && e.before !== "mytable.a").length, 0, "No column drops for non-column DROP sub-clauses");
});

// 11. Dedup: schema + migration describing same column drop collapse into one finding listing both source files
test("schema + migration describing same dropped column collapse into one finding with both source files", () => {
  const schemaBase = "model User {\n  id   Int     @id\n  name String?\n}\n";
  const schemaHead = "model User {\n  id   Int     @id\n}\n";
  const init = { path: "prisma/migrations/001_init/migration.sql", content: "CREATE TABLE \"User\" (\"id\" INTEGER PRIMARY KEY, \"name\" TEXT);" };
  const baseFiles = [{ path: "prisma/schema.prisma", content: schemaBase }, init];
  const headFiles = [
    { path: "prisma/schema.prisma", content: schemaHead },
    init,
    { path: "prisma/migrations/002_drop_name/migration.sql", content: "ALTER TABLE \"User\" DROP COLUMN \"name\";" }
  ];
  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);
  const rules = [
    { id: "no-db-field-removed", on: "db.field_removed", level: "soft" },
    { id: "sql-no-drop-column", on: "sql.drop_column", level: "soft" }
  ];
  const { findings } = evaluateRules(rules, diff, baseFacts, headFacts);
  const nameFindings = findings.filter(f => /user\.name$/i.test(f.event?.entityId || ""));
  assert.equal(nameFindings.length, 1, `one finding for User.name, got ${JSON.stringify(nameFindings.map(f => f.ruleId))}`);
  const files = (nameFindings[0].sources || []).map(x => x.file);
  assert.ok(files.includes("prisma/schema.prisma") && files.includes("prisma/migrations/002_drop_name/migration.sql"), files.join(", "));
  assert.match(formatMarkdownReport(findings), /\(also prisma\//);
});

// 12. Multiple comma-separated ALTER TABLE sub-clauses each parsed individually
test("multiple comma-separated ALTER TABLE sub-clauses each parse individually", () => {
  const base = extractFacts([{ path: "migrations/001.sql", content: "CREATE TABLE t (id int, a text, b text);" }]);
  const head = extractFacts([
    { path: "migrations/001.sql", content: "CREATE TABLE t (id int, a text, b text);" },
    { path: "migrations/002.sql", content: "ALTER TABLE t ADD COLUMN c int, DROP COLUMN a, ALTER COLUMN b TYPE varchar(100);" }
  ]);
  const diff = diffFacts(base, head);
  assert.ok(diff.events.some(e => e.type === "sql.drop_column" && e.before === "t.a"), "DROP COLUMN a parsed");
  assert.ok(head.entities.some(e => e.id === "db.column:t.c"), "ADD COLUMN c parsed");
  assert.ok(diff.events.some(e => e.type === "sql.type_narrowed"), "ALTER COLUMN b TYPE parsed");
});

// 13. New field in Prisma schema that is required does NOT emit made_required finding
test("new required field does not emit db.field_made_required (change-only event should not fire for new entities)", () => {
  const base = extractFacts([{ path: "prisma/schema.prisma", content: "model Claim {\n  id Int @id\n}\n" }]);
  const head = extractFacts([{ path: "prisma/schema.prisma", content: "model Claim {\n  id Int @id\n  envelopeContentCount Int\n}\n" }]);
  const diff = diffFacts(base, head);
  // "Made required" = existing optional -> required. A newly added required field should NOT trigger this.
  const madeRequired = diff.events.filter(e => e.type === "db.field_made_required");
  assert.equal(madeRequired.length, 0, "New required field should NOT emit db.field_made_required");
});

// 14. Existing optional field made required DOES emit made_required finding
test("existing optional field made required DOES emit db.field_made_required", () => {
  const base = extractFacts([{ path: "prisma/schema.prisma", content: "model Claim {\n  id Int @id\n  envelopeContentCount Int?\n}\n" }]);
  const head = extractFacts([{ path: "prisma/schema.prisma", content: "model Claim {\n  id Int @id\n  envelopeContentCount Int\n}\n" }]);
  const diff = diffFacts(base, head);
  // This should fire made_required because the field existed in base (as optional) and is now required
  const madeRequired = diff.events.filter(e => e.type === "db.field_made_required");
  assert.equal(madeRequired.length, 1, "Existing optional->required field SHOULD emit db.field_made_required");
  assert.equal(madeRequired[0].entityId, "db.field:Claim.envelopeContentCount");
});

// 15. Dev compose file: services get environment: "dev"; port-binding rule suppressed for dev-only services
test("dev compose files tag services with environment: dev and suppress no-all-interfaces-port-binding findings", () => {
  const baseFiles = [
    { path: "docker-compose.yml", content: "services:\n  web:\n    image: nginx:latest\n    ports:\n      - '80:80'\n" }
  ];
  const headFiles = [
    { path: "docker-compose.yml", content: "services:\n  web:\n    image: nginx:latest\n    ports:\n      - '80:80'\n" },
    { path: "docker-compose.dev.yml", content: "services:\n  dev-api:\n    image: node:18\n    ports:\n      - '3000:3000'\n" }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  // Dev service should have environment: "dev"
  const devService = headFacts.entities.find(e => e.id === "service:dev-api@docker-compose.dev.yml");
  assert.ok(devService, "dev-api service exists");
  assert.equal(devService.attrs.environment, "dev", "dev compose service gets environment: dev");

  // Port-binding rule with where: { environment: "!dev" } should NOT fire for dev services
  const rules = [
    { id: "no-all-interfaces-port-binding", on: "service.port_published", level: "soft", where: { environment: "!dev" } }
  ];
  const { findings } = evaluateRules(rules, diff, baseFacts, headFacts);
  const portFindings = findings.filter(f => f.ruleId === "no-all-interfaces-port-binding");
  assert.equal(portFindings.length, 0, "Port-binding rule with where: { environment: '!dev' } should not fire for dev services");
});

// 16. Prod compose file: port-binding rule fires normally (not dev)
test("prod compose services still trigger no-all-interfaces-port-binding", () => {
  const baseFiles = [];
  const headFiles = [
    { path: "docker-compose.yml", content: "services:\n  api:\n    image: node:20\n    ports:\n      - '3000:3000'\n" }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  // Prod service should NOT have environment: dev
  const prodService = headFacts.entities.find(e => e.id === "service:api");
  assert.ok(prodService, "api service exists");
  assert.equal(prodService.attrs.environment, undefined, "prod compose service does NOT get environment: dev");

  const rules = [
    { id: "no-all-interfaces-port-binding", on: "service.port_published", level: "soft", where: { environment: "!dev" } }
  ];
  const { findings } = evaluateRules(rules, diff, baseFacts, headFacts);
  const portFindings = findings.filter(f => f.ruleId === "no-all-interfaces-port-binding");
  assert.equal(portFindings.length, 1, "Port-binding rule should fire for non-dev services");
});

// 17. docker-compose.override.yml is recognized as dev compose file
test("docker-compose.override.yml is recognized as dev compose file", () => {
  const main = { path: "docker-compose.yml", content: "services:\n  web:\n    image: nginx:latest\n" };
  const baseFacts = extractFacts([main]);
  const headFacts = extractFacts([main, { path: "docker-compose.override.yml", content: "services:\n  web:\n    ports:\n      - '8080:80'\n" }]);
  const mainWeb = headFacts.entities.find(e => e.id === "service:web");
  const devWeb = headFacts.entities.find(e => e.id === "service:web@docker-compose.override.yml");
  assert.ok(mainWeb && devWeb, "both services exist with stable ids");
  assert.equal(mainWeb.attrs.environment, undefined, "the main service is not marked dev by an override file");
  assert.equal(devWeb.attrs.environment, "dev");
  const { findings } = evaluateRules(RECOMMENDED_RULES, diffFacts(baseFacts, headFacts), baseFacts, headFacts);
  assert.equal(findings.filter(f => f.ruleId === "no-all-interfaces-port-binding").length, 0);
});

// 18. Files matching *local* and *test* are recognized as dev compose files
test("compose files matching *local* and *test* are recognized as dev files", () => {
  const localFacts = extractFacts([{ path: "docker-compose.local.yml", content: "services:\n  test-svc:\n    image: alpine\n" }]);
  const testFacts = extractFacts([{ path: "docker-compose.test.yml", content: "services:\n  ci-svc:\n    image: alpine\n" }]);
  const localSvc = localFacts.entities.find(e => e.name === "test-svc");
  const testSvc = testFacts.entities.find(e => e.name === "ci-svc");
  assert.equal(localSvc.attrs.environment, "dev", "*local* compose gets environment: dev");
  assert.equal(testSvc.attrs.environment, "dev", "*test* compose gets environment: dev");
});

// 19. Compose files under dev/ or .devcontainer/ folder are recognized as dev
test("compose files under dev/ or .devcontainer/ folder are recognized as dev", () => {
  const devFolderFacts = extractFacts([{ path: "dev/docker-compose.yml", content: "services:\n  svc:\n    image: alpine\n" }]);
  const devcontainerFacts = extractFacts([{ path: ".devcontainer/docker-compose.yml", content: "services:\n  svc:\n    image: alpine\n" }]);
  const devSvc = devFolderFacts.entities.find(e => e.name === "svc");
  const devcontainerSvc = devcontainerFacts.entities.find(e => e.name === "svc");
  assert.equal(devSvc.attrs.environment, "dev", "dev/ folder compose gets environment: dev");
  assert.equal(devcontainerSvc.attrs.environment, "dev", ".devcontainer/ folder compose gets environment: dev");
});

// 20. Same service in two compose files (prod + dev) does NOT collapse into one finding for port binding (different environments)
test("same service in two compose files with different environments does not incorrectly dedup findings", () => {
  const baseFiles = [
    { path: "docker-compose.yml", content: "services:\n  api:\n    image: node:20\n" }
  ];
  const headFiles = [
    { path: "docker-compose.yml", content: "services:\n  api:\n    image: node:20\n    ports:\n      - '3000:3000'\n" },
    { path: "docker-compose.dev.yml", content: "services:\n  api:\n    image: node:20\n    ports:\n      - '3001:3001'\n" }
  ];

  const baseFacts = extractFacts(baseFiles);
  const headFacts = extractFacts(headFiles);
  const diff = diffFacts(baseFacts, headFacts);

  const rules = [
    { id: "no-all-interfaces-port-binding", on: "service.port_published", level: "soft", where: { environment: "!dev" } }
  ];
  const { findings } = evaluateRules(rules, diff, baseFacts, headFacts);
  const portFindings = findings.filter(f => f.ruleId === "no-all-interfaces-port-binding");
  // Only the prod port binding should fire (dev one suppressed by where clause)
  assert.equal(portFindings.length, 1, "Only prod port binding should fire (dev suppressed by where clause)");
});






test("ALTER TABLE ADD CONSTRAINT / UNIQUE / PRIMARY KEY / FOREIGN KEY / INDEX never create columns; ADD COLUMN does", () => {
  const base = [{ path: "db/migrations/001.sql", content: "CREATE TABLE \"Doc\" (id INT PRIMARY KEY, checksum TEXT);" }];
  const head = [...base, { path: "db/migrations/002.sql", content: [
    "ALTER TABLE \"Doc\" ADD CONSTRAINT \"Doc_fk\" FOREIGN KEY (\"x\") REFERENCES \"Y\"(\"id\");",
    "ALTER TABLE \"Doc\" ADD UNIQUE (\"checksum\");",
    "ALTER TABLE \"Doc\" ADD PRIMARY KEY (\"id\");",
    "ALTER TABLE `Doc` ADD FOREIGN KEY (x) REFERENCES y(id), ADD INDEX idx_x (x), ADD KEY k (x);",
    "ALTER TABLE \"Doc\" ADD COLUMN \"checksum2\" TEXT;",
    "ALTER TABLE \"Doc\" ADD \"unique_code\" TEXT;"
  ].join("\n") }];
  const cols = extractFacts(head).entities.filter(e => e.kind === "db.column").map(e => e.attrs.name).sort();
  assert.deepEqual(cols, ["checksum", "checksum2", "id", "unique_code"]);
});

test("an edited migration reports only the statements the edit added", () => {
  const before = "CREATE TABLE \"T\" (a INT, b INT, c INT);\nALTER TABLE \"T\" DROP COLUMN a;";
  const base = extractFacts([{ path: "db/migrations/001.sql", content: before }]);
  const head = extractFacts([{ path: "db/migrations/001.sql", content: before + "\nALTER TABLE \"T\" DROP COLUMN b;" }]);
  const events = diffFacts(base, head).events;
  assert.deepEqual(events.filter(e => e.type === "sql.drop_column").map(e => e.entityId), ["db.column:T.b"]);
  assert.equal(events.filter(e => e.type === "sql.migration_edited").length, 1);
});

test("dev compose detection matches name tokens, not substrings", () => {
  assert.equal(isDevComposeFile("docker-compose.dev.yml"), true);
  assert.equal(isDevComposeFile("compose.development.yaml"), true);
  assert.equal(isDevComposeFile("deploy/local/compose.yml"), true);
  assert.equal(isDevComposeFile("docker/development/compose.yml"), true);
  assert.equal(isDevComposeFile(".devcontainer/docker-compose.yml"), true);
  assert.equal(isDevComposeFile("docker-compose.device.yml"), false);
  assert.equal(isDevComposeFile("docker-compose.latest.yml"), false);
  assert.equal(isDevComposeFile("devops/docker-compose.yml"), false);
  assert.equal(isDevComposeFile("docker-compose.yml"), false);
});

test("dedup keeps two different ports on one service as two findings and never rewrites event ids", () => {
  const baseFacts = extractFacts([{ path: "docker-compose.yml", content: "services:\n  api:\n    image: node:20\n" }]);
  const headFacts = extractFacts([{ path: "docker-compose.yml", content: "services:\n  api:\n    image: node:20\n    ports:\n      - '80:80'\n      - '443:443'\n" }]);
  const { findings } = evaluateRules(RECOMMENDED_RULES, diffFacts(baseFacts, headFacts), baseFacts, headFacts);
  const ports = findings.filter(f => f.ruleId === "no-all-interfaces-port-binding");
  assert.equal(ports.length, 2);
  assert.ok(ports.every(f => f.event.entityId === "service:api"));
});

test("a new required Prisma field on a new model or an existing model is not 'made required'", () => {
  const base = extractFacts([{ path: "prisma/schema.prisma", content: "model A {\n  id Int @id\n}\n" }]);
  const head = extractFacts([{ path: "prisma/schema.prisma", content: "model A {\n  id Int @id\n  count Int\n  meta Json @default(\"{}\")\n  url String @default(\"https://x.test/a\")\n}\nmodel B {\n  id Int @id\n  name String\n}\n" }]);
  const diff = diffFacts(base, head);
  assert.equal(diff.events.filter(e => e.type === "db.field_made_required").length, 0);
  const fields = head.entities.filter(e => e.kind === "db.field" && e.attrs.model === "A").map(e => e.attrs.name).sort();
  assert.deepEqual(fields, ["count", "id", "meta", "url"]);
});

test("SET NOT NULL after a backfill UPDATE in the same migration is the safe pattern; without it, it is a finding", () => {
  const base = extractFacts([{ path: "db/migrations/001.sql", content: "CREATE TABLE \"Claim\" (id INT PRIMARY KEY);" }]);
  const safe = [
    "ALTER TABLE \"Claim\" ADD COLUMN \"a\" INTEGER, ADD COLUMN \"b\" INTEGER;",
    "UPDATE \"Claim\" SET \"a\" = 0, \"b\" = COALESCE(\"b\", 0) WHERE \"a\" IS NULL;",
    "ALTER TABLE \"Claim\" ALTER COLUMN \"a\" SET NOT NULL, ALTER COLUMN \"b\" SET NOT NULL;"
  ].join("\n");
  const unsafe = "ALTER TABLE \"Claim\" ADD COLUMN \"c\" INTEGER;\nALTER TABLE \"Claim\" ALTER COLUMN \"c\" SET NOT NULL;";
  const files = (sql) => [{ path: "db/migrations/001.sql", content: "CREATE TABLE \"Claim\" (id INT PRIMARY KEY);" }, { path: "db/migrations/002.sql", content: sql }];
  const nn = (sql) => diffFacts(base, extractFacts(files(sql))).events.filter(e => e.type === "sql.not_null_without_default").map(e => e.entityId);
  assert.deepEqual(nn(safe), []);
  assert.deepEqual(nn(unsafe), ["db.column:Claim.c"]);
});

test("diffSqlFacts detects deleted migration as sql.migration_edited ('deleted')", () => {
  const base = extractFacts([
    { path: "db/migrations/001.sql", content: "CREATE TABLE u (id INT PRIMARY KEY);" },
    { path: "db/migrations/002.sql", content: "CREATE TABLE p (id INT PRIMARY KEY);" }
  ]);
  const head = extractFacts([
    { path: "db/migrations/001.sql", content: "CREATE TABLE u (id INT PRIMARY KEY);" }
  ]);
  const diff = diffFacts(base, head);
  const editEvent = diff.events.find(e => e.type === "sql.migration_edited");
  assert.ok(editEvent, "Expected sql.migration_edited event for deleted migration");
  assert.ok(editEvent.message.includes("deleted"), `Expected 'deleted' in message: ${editEvent.message}`);
});

test("diffSqlFacts detects renamed migration as sql.migration_edited ('renamed from')", () => {
  const sql = "CREATE TABLE u (id INT PRIMARY KEY);\n";
  const base = extractFacts([
    { path: "db/migrations/001_init.sql", content: sql }
  ]);
  const head = extractFacts([
    { path: "db/migrations/001_init_users.sql", content: sql }
  ]);
  const diff = diffFacts(base, head);
  const editEvent = diff.events.find(e => e.type === "sql.migration_edited");
  assert.ok(editEvent, "Expected sql.migration_edited event for renamed migration");
  assert.ok(editEvent.message.includes("renamed from"), `Expected 'renamed from' in message: ${editEvent.message}`);
});

test("diffSqlFacts ignores CRLF-only line ending differences in migrations", () => {
  const base = extractFacts([
    { path: "db/migrations/001.sql", content: "CREATE TABLE u (\n  id INT PRIMARY KEY\n);\n" }
  ]);
  const head = extractFacts([
    { path: "db/migrations/001.sql", content: "CREATE TABLE u (\r\n  id INT PRIMARY KEY\r\n);\r\n" }
  ]);
  const diff = diffFacts(base, head);
  const editEvents = diff.events.filter(e => e.type === "sql.migration_edited");
  assert.equal(editEvents.length, 0, "CRLF differences must not produce sql.migration_edited events");
});

test("golang-migrate down file with DROP COLUMN produces no finding and check exits 0", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-down-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-sql-down-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

    fs.writeFileSync(path.join(tmpBase, "migrations", "000001_init.up.sql"), "CREATE TABLE users (\n  id INT PRIMARY KEY\n);\n");
    fs.writeFileSync(path.join(tmpHead, "migrations", "000001_init.up.sql"), "CREATE TABLE users (\n  id INT PRIMARY KEY\n);\n");

    // Head adds a new pair: up adds a column, down drops it
    fs.writeFileSync(path.join(tmpHead, "migrations", "000002_add_email.up.sql"), "ALTER TABLE users ADD COLUMN email VARCHAR(255);\n");
    fs.writeFileSync(path.join(tmpHead, "migrations", "000002_add_email.down.sql"), "ALTER TABLE users DROP COLUMN email;\n");

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for golang-migrate down file, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const dropFindings = parsed.findings.filter(f => f.ruleId === "sql-no-drop-column");
    assert.equal(dropFindings.length, 0, "golang-migrate down file must not produce drop findings");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

test("dbmate file with DROP COLUMN only in down section exits 0; in up section produces finding", () => {
  // Case A: DROP COLUMN only in -- migrate:down section -> exit 0
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-dbmate-down-base-"));
    const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-dbmate-down-head-"));
    try {
      fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
      fs.mkdirSync(path.join(tmpHead, "db", "migrations"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpHead, "db", "migrations", "20261116000000_add_name.sql"),
        `-- migrate:up
ALTER TABLE users ADD COLUMN name VARCHAR(100);

-- migrate:down
ALTER TABLE users DROP COLUMN name;
`
      );

      const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 0, `Expected exit 0 for dbmate file with DROP COLUMN only in down section, got ${r.status}: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.exitCode, 0);
      assert.equal(parsed.findings.filter(f => f.ruleId === "sql-no-drop-column").length, 0);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpHead, { recursive: true, force: true });
    }
  }

  // Case B: DROP COLUMN in -- migrate:up section -> finding (exit 2)
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-dbmate-up-base-"));
    const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-dbmate-up-head-"));
    try {
      fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
      fs.mkdirSync(path.join(tmpHead, "db", "migrations"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpHead, "db", "migrations", "20261116000001_drop_legacy.sql"),
        `-- migrate:up
ALTER TABLE users DROP COLUMN legacy_field;

-- migrate:down
ALTER TABLE users ADD COLUMN legacy_field VARCHAR(100);
`
      );

      const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 2, `Expected exit 2 for dbmate file with DROP COLUMN in up section, got ${r.status}: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.exitCode, 2);
      assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-drop-column"), "Expected sql-no-drop-column finding for up section drop");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpHead, { recursive: true, force: true });
    }
  }
});

test("temp table created and dropped in the same migration produces no drop finding", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "check-temp-table-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "check-temp-table-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpHead, "migrations", "001_temp_migration.sql"),
      `CREATE TEMPORARY TABLE staging_users (
  id INT,
  data TEXT
);

-- perform data transformations ...

DROP TABLE staging_users;
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for temp table created and dropped, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    const dropFindings = parsed.findings.filter(f => f.ruleId === "sql-no-drop-table");
    assert.equal(dropFindings.length, 0, "No drop table finding should be produced for table created and dropped in the same migration");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// goose down section with DROP COLUMN -> exit 0; in Up section -> finding
test("goose down section with DROP COLUMN -> exit 0; in Up section -> finding", () => {
  // Case A: drop in Down section
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "goose-down-base-"));
    const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "goose-down-head-"));
    try {
      fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
      fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpHead, "migrations", "0001_users.sql"),
        `-- +goose Up
ALTER TABLE users ADD COLUMN age INT;

-- +goose Down
ALTER TABLE users DROP COLUMN age;
`
      );

      const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 0, `Expected exit 0 for drop in goose down section: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.exitCode, 0);
      assert.equal(parsed.findings.filter(f => f.ruleId === "sql-no-drop-column").length, 0);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpHead, { recursive: true, force: true });
    }
  }

  // Case B: drop in Up section
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "goose-up-base-"));
    const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "goose-up-head-"));
    try {
      fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
      fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpHead, "migrations", "0001_users.sql"),
        `-- +goose Up
ALTER TABLE users DROP COLUMN age;

-- +goose Down
ALTER TABLE users ADD COLUMN age INT;
`
      );

      const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 2, `Expected exit 2 for drop in goose up section: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.exitCode, 2);
      assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-drop-column"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpHead, { recursive: true, force: true });
    }
  }
});

// sql-migrate down section with DROP COLUMN -> exit 0; in Up section -> finding
test("sql-migrate down section with DROP COLUMN -> exit 0; in Up section -> finding", () => {
  // Case A: drop in Down section
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sqlmigrate-down-base-"));
    const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "sqlmigrate-down-head-"));
    try {
      fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
      fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpHead, "migrations", "0001_users.sql"),
        `-- +migrate Up
ALTER TABLE users ADD COLUMN age INT;

-- +migrate Down
ALTER TABLE users DROP COLUMN age;
`
      );

      const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 0, `Expected exit 0 for drop in sql-migrate down section: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.exitCode, 0);
      assert.equal(parsed.findings.filter(f => f.ruleId === "sql-no-drop-column").length, 0);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpHead, { recursive: true, force: true });
    }
  }

  // Case B: drop in Up section
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "sqlmigrate-up-base-"));
    const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "sqlmigrate-up-head-"));
    try {
      fs.mkdirSync(path.join(tmpBase, "migrations"), { recursive: true });
      fs.mkdirSync(path.join(tmpHead, "migrations"), { recursive: true });

      fs.writeFileSync(
        path.join(tmpHead, "migrations", "0001_users.sql"),
        `-- +migrate Up
ALTER TABLE users DROP COLUMN age;

-- +migrate Down
ALTER TABLE users ADD COLUMN age INT;
`
      );

      const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
      assert.equal(r.status, 2, `Expected exit 2 for drop in sql-migrate up section: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.exitCode, 2);
      assert.ok(parsed.findings.some(f => f.ruleId === "sql-no-drop-column"));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpHead, { recursive: true, force: true });
    }
  }
});

// Flyway undo migration U2__undo.sql is ignored
test("Flyway undo migration U2__undo.sql is ignored", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-undo-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-undo-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migration"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "migration"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpHead, "db", "migration", "U2__undo_drop.sql"),
      "ALTER TABLE users DROP COLUMN email;\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `Expected exit 0 for Flyway undo file: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.findings.length, 0, "Flyway undo migration should produce zero findings");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// Flyway V2 file with a -- +goose Down comment before a DROP is still a finding
test("Flyway V2 file with a -- +goose Down comment before a DROP is still a finding", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-goose-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-goose-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migration"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "migration"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpBase, "db", "migration", "V1__init.sql"),
      "CREATE TABLE users (id int, email text);\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "db", "migration", "V1__init.sql"),
      "CREATE TABLE users (id int, email text);\n"
    );

    // Flyway versioned file with goose markers
    fs.writeFileSync(
      path.join(tmpHead, "db", "migration", "V2__drop.sql"),
      `-- +goose Up
ALTER TABLE users ADD COLUMN name text;

-- +goose Down
ALTER TABLE users DROP COLUMN email;
`
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 because Flyway does not honour goose down markers: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-drop-column"),
      "Flyway versioned file must execute fully and flag drop column despite goose Down marker"
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// Flyway repeatable migrations: R__*.sql edit does not trigger sql-no-migration-edited, but statements inside are judged
test("Flyway repeatable migration R__*.sql edit is not sql-no-migration-edited, but DROP COLUMN inside it is still found", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-repeatable-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "flyway-repeatable-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migration"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "db", "migration"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpBase, "db", "migration", "R__views.sql"),
      "CREATE OR REPLACE VIEW user_emails AS SELECT id, email FROM users;\n"
    );
    // Edited in head: drops a column inside the repeatable migration
    fs.writeFileSync(
      path.join(tmpHead, "db", "migration", "R__views.sql"),
      "ALTER TABLE users DROP COLUMN email;\nCREATE OR REPLACE VIEW user_emails AS SELECT id FROM users;\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 (soft drop column, not hard migration edited): ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);
    // Must NOT have sql-no-migration-edited
    assert.ok(
      !parsed.findings.some(f => f.ruleId === "sql-no-migration-edited"),
      "Repeatable R__ migration edit must not produce hard sql-no-migration-edited"
    );
    // Must flag the DROP COLUMN statement inside it
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-drop-column"),
      "DROP COLUMN inside repeatable migration must still be detected"
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// Mass moves: renaming applied migrations with identical content across folders is soft
test("moving 3 identical migrations across folders produces one soft finding", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mass-move-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "mass-move-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "apps", "db", "migrations"), { recursive: true });

    for (let i = 1; i <= 3; i++) {
      const content = `CREATE TABLE table_${i} (id INT PRIMARY KEY);\n`;
      fs.writeFileSync(path.join(tmpBase, "db", "migrations", `V${i}__create_${i}.sql`), content);
      fs.writeFileSync(path.join(tmpHead, "apps", "db", "migrations", `V${i}__create_${i}.sql`), content);
    }

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, `Expected exit 2 for soft folder move, got ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 2);

    const hardEdited = parsed.findings.filter(f => f.ruleId === "sql-no-migration-edited");
    assert.equal(hardEdited.length, 0, "Mass move with identical content must not produce hard sql-no-migration-edited");

    const moveFindings = parsed.findings.filter(f => f.ruleId === "sql-migrations-moved");
    assert.equal(moveFindings.length, 1, "Must produce exactly one soft finding for folder move");
    assert.ok(
      moveFindings[0].message.includes("3 migrations moved from db/migrations to apps/db/migrations"),
      `Finding message should state count and dirs: ${moveFindings[0].message}`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});

// Migration rename with changed content stays hard sql-no-migration-edited
test("migration rename with changed content stays hard sql-no-migration-edited", () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "rename-diff-base-"));
  const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "rename-diff-head-"));
  try {
    fs.mkdirSync(path.join(tmpBase, "db", "migrations"), { recursive: true });
    fs.mkdirSync(path.join(tmpHead, "apps", "db", "migrations"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpBase, "db", "migrations", "V1__init.sql"),
      "CREATE TABLE users (id int);\n"
    );
    fs.writeFileSync(
      path.join(tmpHead, "apps", "db", "migrations", "V1__init.sql"),
      "CREATE TABLE users (id int, email text);\n"
    );

    const r = spawnSync(process.execPath, [CLI, "check", tmpBase, tmpHead, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 1, `Expected exit 1 for migration rename with changed content: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.exitCode, 1);
    assert.ok(
      parsed.findings.some(f => f.ruleId === "sql-no-migration-edited"),
      "Renamed migration with changed content must trigger hard sql-no-migration-edited"
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(tmpHead, { recursive: true, force: true });
  }
});


// T-103: SQLite table-rebuild idiom (create new, copy, drop old, rename new to old) is not a drop
test("sqlite table rebuild is not reported as a dropped table but column removal is", () => {
  const baseSql = "CREATE TABLE users (id int, email text, name text);";
  const base = extractFacts([{ path: "migrations/001_users.sql", content: baseSql }]);
  const head = extractFacts([
    { path: "migrations/001_users.sql", content: baseSql },
    {
      path: "migrations/002_rebuild.sql",
      content: `CREATE TABLE "new_users" (id int, name text);
INSERT INTO "new_users" (id, name) SELECT id, name FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";`
    }
  ]);
  const diff = diffFacts(base, head);
  assert.equal(
    diff.events.filter(e => e.type === "sql.drop_table").length,
    0,
    "A table rebuilt via create/copy/drop/rename must not emit sql.drop_table"
  );
  const removedCol = diff.events.find(e => e.type === "db.field_removed" && e.before === "users.email");
  assert.ok(removedCol, "The removed column still has to be reported after the rebuild");
});

// T-103: a plain DROP TABLE is still a drop
test("plain DROP TABLE without a later rename is still a dropped table", () => {
  const baseSql = "CREATE TABLE users (id int, email text);";
  const base = extractFacts([{ path: "migrations/001_users.sql", content: baseSql }]);
  const head = extractFacts([
    { path: "migrations/001_users.sql", content: baseSql },
    { path: "migrations/002_drop.sql", content: "DROP TABLE users;" }
  ]);
  const diff = diffFacts(base, head);
  assert.ok(diff.events.some(e => e.type === "sql.drop_table"), "A plain DROP TABLE must still emit sql.drop_table");
});

// T-103: CONCURRENTLY is PostgreSQL-only, so MySQL/SQLite migrations must not warn
test("index_without_concurrently is not reported for a MySQL migration path", () => {
  const base = extractFacts([{ path: "migrations/001_init.sql", content: "CREATE TABLE t1 (id int);" }]);
  const head = extractFacts([
    { path: "migrations/001_init.sql", content: "CREATE TABLE t1 (id int);" },
    { path: "db/mysql/migrations/002_idx.sql", content: "CREATE INDEX i ON t1 (id);" }
  ]);
  const diff = diffFacts(base, head);
  assert.equal(
    diff.events.filter(e => e.type === "sql.index_without_concurrently").length,
    0,
    "MySQL migrations have no CONCURRENTLY"
  );
});

// T-103: the same CREATE INDEX under a generic migrations dir still warns
test("index_without_concurrently is still reported for a PostgreSQL migration path", () => {
  const base = extractFacts([{ path: "db/migrations/001_init.sql", content: "CREATE TABLE t1 (id int);" }]);
  const head = extractFacts([
    { path: "db/migrations/001_init.sql", content: "CREATE TABLE t1 (id int);" },
    { path: "db/migrations/002_idx.sql", content: "CREATE INDEX i ON t1 (id);" }
  ]);
  const diff = diffFacts(base, head);
  assert.ok(diff.events.some(e => e.type === "sql.index_without_concurrently"));
});
