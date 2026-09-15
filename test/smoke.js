"use strict";

/**
 * Rauchtest gegen ein echtes abas-System. Kein Teil der automatischen
 * Testsuite - die laeuft gegen den Mock und braucht kein ERP.
 *
 *   ABAS_PASSWORD=... node test/smoke.js --host koenesr200 --client entw
 */

const { connect } = require("../dist/index");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const optionen = {
    host: arg("host", process.env.ABAS_EDP_HOST || "localhost"),
    port: Number(arg("port", process.env.ABAS_EDP_PORT || 6550)),
    client: arg("client", process.env.ABAS_EDP_CLIENT || "entw"),
    password: process.env.ABAS_PASSWORD || "",
    appName: "abas-edp-smoke",
    logger: (richtung, text) => {
      const pfeil = richtung === "send" ? ">>>" : richtung === "receive" ? "<<<" : "---";
      console.log(`${pfeil} ${text}`);
    },
  };

  if (!optionen.password) {
    console.error("ABAS_PASSWORD fehlt");
    process.exitCode = 2;
    return;
  }

  console.log(`Verbinde mit ${optionen.host}:${optionen.port}, Mandant ${optionen.client}\n`);
  const session = await connect(optionen);
  console.log(`\nAngemeldet: ${session.serverInfo}\n`);

  // Datenbank 31 ist im Zielmandanten die WIP-Zusatzdatenbank.
  const tabellen = await session.query("GTN", [arg("filter", "31"), "20", "0"]);
  console.log(`\nTabellen: ${tabellen.rows.length} (vollstaendig=${tabellen.ok}, weitere=${tabellen.hasMore})`);
  for (const zeile of tabellen.rows) {
    console.log(`  ${String(zeile[0]).padEnd(30)} ${zeile[2] ?? ""}`);
  }

  await session.close();
  console.log("\nRauchtest bestanden.");
}

main().catch((fehler) => {
  console.error(`\nFEHLGESCHLAGEN: ${fehler.message}`);
  process.exitCode = 1;
});
