"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { startMockServer } = require("../scripts/mock-server");
const { EdpClient } = require("../dist/index");

function neuerClient(server, extra = {}) {
  return new EdpClient({
    host: "127.0.0.1",
    port: server.port,
    client: "entw",
    password: "geheim",
    ...extra,
  });
}

test("meldet sich erst beim ersten Zugriff an", async () => {
  const server = await startMockServer();
  const client = neuerClient(server);
  try {
    assert.equal(client.isConnected, false);
    await client.use((session) => session.select({ table: "31:0", fields: ["such"] }));
    assert.equal(client.isConnected, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("haelt genau eine Sitzung, auch bei vielen Zugriffen", async () => {
  const server = await startMockServer();
  const client = neuerClient(server);
  try {
    const ergebnisse = await Promise.all([
      client.use((s) => s.select({ table: "31:0", fields: ["such"] })),
      client.use((s) => s.select({ table: "31:0", fields: ["such"] })),
      client.use((s) => s.select({ table: "31:0", fields: ["such"] })),
    ]);
    for (const e of ergebnisse) assert.equal(e.rows.length, 2);
    // Entscheidend: nur EINE Anmeldung, also nur eine Lizenz.
    assert.equal(server.loginCount(), 1, "es darf nur eine Anmeldung gegeben haben");
  } finally {
    await client.close();
    await server.close();
  }
});

test("Zugriffe laufen nacheinander, nicht ineinander", async () => {
  const server = await startMockServer();
  const client = neuerClient(server);
  const verlauf = [];
  try {
    await Promise.all([
      client.use(async (s) => {
        verlauf.push("A start");
        await s.select({ table: "31:0", fields: ["such"] });
        verlauf.push("A ende");
      }),
      client.use(async (s) => {
        verlauf.push("B start");
        await s.select({ table: "31:0", fields: ["such"] });
        verlauf.push("B ende");
      }),
    ]);
    assert.deepEqual(verlauf, ["A start", "A ende", "B start", "B ende"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("meldet sich nach Leerlauf ab und gibt die Lizenz frei", async () => {
  const server = await startMockServer();
  const client = neuerClient(server, { idleTimeoutMs: 120 });
  try {
    await client.use((s) => s.select({ table: "31:0", fields: ["such"] }));
    assert.equal(client.isConnected, true);

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(client.isConnected, false, "nach Leerlauf abgemeldet");

    // Der naechste Zugriff meldet sich neu an.
    await client.use((s) => s.select({ table: "31:0", fields: ["such"] }));
    assert.equal(client.isConnected, true);
    assert.equal(server.loginCount(), 2, "zweite Anmeldung nach dem Leerlauf");
  } finally {
    await client.close();
    await server.close();
  }
});

test("verbindet neu, wenn der Server die Sitzung abgeraeumt hat", async () => {
  const server = await startMockServer();
  const client = neuerClient(server);
  try {
    await client.use((s) => s.select({ table: "31:0", fields: ["such"] }));
    assert.equal(server.loginCount(), 1);

    // Serverseitiger Abbruch, wie er nach langem Leerlauf vorkommen kann.
    server.dropConnections();
    await new Promise((r) => setTimeout(r, 80));

    const ergebnis = await client.use((s) => s.select({ table: "31:0", fields: ["such"] }));
    assert.equal(ergebnis.rows.length, 2);
    assert.equal(server.loginCount(), 2, "nach dem Abbruch neu angemeldet");
  } finally {
    await client.close();
    await server.close();
  }
});

test("nach close() wird nicht mehr gearbeitet", async () => {
  const server = await startMockServer();
  const client = neuerClient(server);
  await client.use((s) => s.select({ table: "31:0", fields: ["such"] }));
  await client.close();
  await assert.rejects(() => client.use(async () => 1), /geschlossen/);
  await server.close();
});
