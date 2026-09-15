"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer } = require("./mock-server");
const { connect, EdpError } = require("../dist/index");

async function mitServer(fn, optionen) {
  const server = await startMockServer(optionen);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

test("meldet sich an und liest eine Datenmenge", async () => {
  await mitServer(async (server) => {
    const session = await connect({
      host: "127.0.0.1",
      port: server.port,
      client: "entw",
      password: "geheim",
      appName: "test",
    });

    assert.match(session.serverInfo, /Logon erfolgreich/);

    const ergebnis = await session.query("GTN", ["", "20", "0"]);
    assert.equal(ergebnis.rows.length, 3);
    assert.ok(ergebnis.ok);
    assert.ok(ergebnis.hasMore, "eof=0 bedeutet, dass noch Daten folgen");

    // Sonderzeichen kommen entmaskiert an
    assert.deepEqual(ergebnis.rows[1], ["Artikel", "Bez mit | und \n und \\", "2:1"]);

    // Ueber drei Saetze verteilte Zeile ist wieder eine Zeile
    assert.deepEqual(ergebnis.rows[2], ["Lieferant", "Anfang-Mitte-Ende", "1:1"]);

    await session.close();
  });
});

test("nennt bei Ablehnung den Grund aus dem E-Satz", async () => {
  await mitServer(async (server) => {
    await assert.rejects(
      () =>
        connect({
          host: "127.0.0.1",
          port: server.port,
          client: "entw",
          password: "falsch",
        }),
      (fehler) => {
        assert.ok(fehler instanceof EdpError);
        assert.match(fehler.message, /Ungueltiges Passwort/);
        assert.equal(fehler.code, "17");
        return true;
      }
    );
  });
});

test("weist ein leeres Passwort ab, bevor verbunden wird", async () => {
  await assert.rejects(
    () => connect({ host: "127.0.0.1", port: 1, client: "entw", password: "" }),
    /Passwort fehlt/
  );
});

test("das Passwort taucht im Mitschnitt nicht auf", async () => {
  await mitServer(async (server) => {
    const zeilen = [];
    const session = await connect({
      host: "127.0.0.1",
      port: server.port,
      client: "entw",
      password: "streng-geheim",
      logger: (richtung, text) => zeilen.push(`${richtung} ${text}`),
    });
    await session.close();

    const alles = zeilen.join("\n");
    assert.ok(alles.includes("LGN|"), "der Anmeldesatz wurde protokolliert");
    assert.ok(!alles.includes("streng-geheim"), "das Passwort steht nicht im Mitschnitt");
    assert.ok(alles.includes("***"), "es wurde ersetzt");
  });
});
