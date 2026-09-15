"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer } = require("../scripts/mock-server");
const { connect } = require("../dist/index");

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

test("oeffnet ein Infosystem, setzt Felder, druckt Start und liest Zeilen", async () => {
  await mitSession(async (session) => {
    const is = await session.openInfosystem("PRODLIST", { workingDir: "owfe" });
    await is.setField("bba", "1");
    await is.click("bstart");

    const zeilen = await is.getFields(["order", "art", "frgmge"], "*");
    assert.equal(zeilen.length, 2);
    assert.deepEqual(zeilen[0], { order: "1479", art: "100481", frgmge: "10" });
    assert.deepEqual(zeilen[1], { order: "1479001", art: "A 00015", frgmge: "9" });

    await is.cancel();
  });
});

test("entfernt die Auffuellung der Externdarstellung", async () => {
  // Der Mock liefert "        1479" - so wie abas Verweise auf Feldbreite
  // auffuellt. Ohne Normalisierung scheitert jeder Vergleich daran.
  await mitSession(async (session) => {
    const is = await session.openInfosystem("PRODLIST");
    const zeilen = await is.getFields(["order"], "*");
    assert.equal(zeilen[0].order, "1479");
    await is.cancel();
  });
});

test("mit trimValues:false bleiben die Rohwerte erhalten", async () => {
  await mitSession(
    async (session) => {
      const is = await session.openInfosystem("PRODLIST");
      const zeilen = await is.getFields(["order"], "*");
      assert.match(zeilen[0].order, /^\s+1479$/);
      await is.cancel();
    },
    { trimValues: false }
  );
});

test("Kopffelder ohne Zeilenangabe", async () => {
  await mitSession(async (session) => {
    const is = await session.openInfosystem("PRODLIST");
    const kopf = await is.getFields(["kba"]);
    assert.equal(kopf.length, 1);
    assert.equal(kopf[0].kba, "");
    await is.cancel();
  });
});
