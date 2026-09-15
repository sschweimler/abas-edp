"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer } = require("../scripts/mock-server");
const { connect, DEFAULT_OPTIONS } = require("../dist/index");

async function mitSession(fn, optionen = {}) {
  const server = await startMockServer();
  const session = await connect({
    host: "127.0.0.1",
    port: server.port,
    client: "entw",
    password: "geheim",
    ...optionen,
  });
  try {
    await fn(session);
  } finally {
    await session.close();
    await server.close();
  }
}

test("setzt die Darstellungsoptionen nach der Anmeldung", async () => {
  await mitSession(async (session) => {
    const ergebnis = await session.select({ table: "31:0", fields: ["such", "pbanr", "pmge"] });
    // NUMMODE=RAW gehoert zur Vorgabe, deshalb kommt die Zahl mit Punkt.
    assert.equal(ergebnis.records[0].pmge, "2.5");
    assert.equal(Number(ergebnis.records[0].pmge), 2.5);
  });
  assert.equal(DEFAULT_OPTIONS.NUMMODE, "RAW");
});

test("ohne Vorgabeoptionen kommt die Zahl in Bediensprache", async () => {
  // Belegt, dass die Vorgabe wirklich etwas bewirkt - und warum es ohne
  // sie schiefginge: Number("2,5") ist NaN.
  await mitSession(
    async (session) => {
      const ergebnis = await session.select({ table: "31:0", fields: ["such", "pbanr", "pmge"] });
      assert.equal(ergebnis.records[0].pmge, "2,5");
      assert.ok(Number.isNaN(Number(ergebnis.records[0].pmge)));
    },
    { options: {} }
  );
});

test("ordnet Felder ueber die Position zu", async () => {
  await mitSession(async (session) => {
    const ergebnis = await session.select({ table: "31:0", fields: ["such", "pbanr", "pmge"] });
    assert.deepEqual(ergebnis.fields, ["such", "pbanr", "pmge"]);
    assert.deepEqual(ergebnis.records[1], {
      such: "WIP.1489.20260914135318",
      pbanr: "1489",
      pmge: "1",
    });
    assert.deepEqual(ergebnis.rows[1], ["WIP.1489.20260914135318", "1489", "1"]);
  });
});

test("meldet, dass weitere Saetze folgen", async () => {
  await mitSession(async (session) => {
    const seite1 = await session.select({ table: "31:0", fields: ["such"], pageSize: 2 });
    assert.equal(seite1.rows.length, 2);
    assert.ok(seite1.hasMore);

    const seite2 = await session.next();
    assert.equal(seite2.rows.length, 1);
    assert.ok(!seite2.hasMore);
  });
});

test("selectAll holt alle Teilmengen zusammen", async () => {
  await mitSession(async (session) => {
    const alles = await session.selectAll({ table: "31:0", fields: ["such", "pbanr"], pageSize: 2 });
    assert.equal(alles.rows.length, 3);
    assert.ok(!alles.hasMore);
    assert.deepEqual(
      alles.records.map((r) => r.pbanr),
      ["1479", "1489", "1494"]
    );
  });
});

test("Weiterlesen ohne vorherige Abfrage ist ein Fehler", async () => {
  await mitSession(async (session) => {
    await assert.rejects(() => session.next(), /noch keine Abfrage/);
  });
});
