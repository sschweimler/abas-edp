"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer } = require("../scripts/mock-server");
const { connect, EdpError } = require("../dist/index");

async function mitSession(fn) {
  const server = await startMockServer();
  const session = await connect({
    host: "127.0.0.1",
    port: server.port,
    client: "entw",
    password: "geheim",
  });
  try {
    await fn(session);
  } finally {
    await session.close();
    await server.close();
  }
}

test("legt einen Datensatz an und liefert Referenz und Identnummer", async () => {
  await mitSession(async (session) => {
    const { ref, num } = await session.edit(
      () => session.createRecord("31:1"),
      async (editor) => {
        await editor.setField("such", "WIP.TEST");
        await editor.setField("plbez", "Testplatz");
      }
    );
    assert.match(ref, /^\(\d+,31,0\)$/);
    assert.ok(num.length > 0);
  });
});

test("schreibt Zeilenfelder ueber die Zeilenangabe", async () => {
  await mitSession(async (session) => {
    await session.edit(
      () => session.createRecord("31:0"),
      async (editor) => {
        await editor.setField("such", "WIP.TEST.ZEILEN");
        await editor.insertRow();
        await editor.setField("ipmgvb", "2.5", 1);
        assert.equal(await editor.statusOf("NUMROWS"), "1");
      }
    );
  });
});

test("bricht die Aktion ab, wenn im Rumpf etwas schiefgeht", async () => {
  await mitSession(async (session) => {
    await assert.rejects(
      () =>
        session.edit(
          () => session.createRecord("31:1"),
          async (editor) => {
            await editor.setField("such", "WIP.TEST");
            await editor.setField("gibtesnicht", "x");
          }
        ),
      (fehler) => {
        assert.ok(fehler instanceof EdpError);
        assert.match(fehler.message, /Grund laut Server.*existiert nicht/s);
        return true;
      }
    );

    // Entscheidend: Die Aktion wurde abgeraeumt. Waere sie offen
    // geblieben, wuerde der Server jeden weiteren Editor ablehnen -
    // der Folgefehler traete weit entfernt von seiner Ursache auf.
    const { ref } = await session.edit(
      () => session.createRecord("31:1"),
      async (editor) => editor.setField("such", "WIP.DANACH")
    );
    assert.match(ref, /^\(\d+,31,0\)$/);
  });
});

test("ein zweiter Editor wird abgelehnt, solange einer offen ist", async () => {
  await mitSession(async (session) => {
    const ersterEditor = await session.createRecord("31:1");
    await assert.rejects(() => session.createRecord("31:1"), /bereits ein Editor aktiv/);
    await ersterEditor.cancel();
  });
});

test("nach commit ist die Aktion zu", async () => {
  await mitSession(async (session) => {
    const editor = await session.createRecord("31:1");
    await editor.setField("such", "WIP.ZU");
    await editor.commit();
    assert.ok(editor.isFinished);
    await assert.rejects(() => editor.setField("such", "nochmal"), /bereits abgeschlossen/);
  });
});
