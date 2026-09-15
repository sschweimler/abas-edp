"use strict";

/**
 * Rauchtest gegen ein echtes abas-System. Kein Teil der automatischen
 * Testsuite - die laeuft gegen den Mock und braucht kein ERP.
 *
 *   ABAS_PASSWORD=... node scripts/smoke.js --host koenesr200 --client entw
 *
 * Prueft ueber EDP dieselben Daten, die die WIP-Anwendung heute ueber die
 * REST-Middleware liest, und vergleicht sie mit den dort bekannten
 * Ergebnissen. Damit ist belegbar, dass beide Wege dasselbe liefern.
 */

const { connect } = require("../dist/index");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

let fehler = 0;
function pruefe(bezeichnung, bedingung, zusatz = "") {
  const zeichen = bedingung ? "  ok  " : "FEHLER";
  if (!bedingung) fehler++;
  console.log(`  [${zeichen}] ${bezeichnung}${zusatz ? ` - ${zusatz}` : ""}`);
}

async function main() {
  const optionen = {
    host: arg("host", process.env.ABAS_EDP_HOST || "localhost"),
    port: Number(arg("port", process.env.ABAS_EDP_PORT || 6550)),
    client: arg("client", process.env.ABAS_EDP_CLIENT || "entw"),
    password: process.env.ABAS_PASSWORD || "",
    appName: "abas-edp-smoke",
    // Verweise als Suchwort - fuer die WIP-Daten genau das, was angezeigt
    // und auch zurueckgeschrieben wird.
    options: { NUMMODE: "RAW", BOOLMODE: "NUM", DATEMODE: "SORT", VERWMODE: "SW" },
  };

  if (!optionen.password) {
    console.error("ABAS_PASSWORD fehlt");
    process.exitCode = 2;
    return;
  }

  if (process.argv.includes("--verbose")) {
    optionen.logger = (richtung, text) => {
      const pfeil = richtung === "send" ? ">>>" : richtung === "receive" ? "<<<" : "---";
      console.log(`${pfeil} ${text}`);
    };
  }

  console.log(`Verbinde mit ${optionen.host}:${optionen.port}, Mandant ${optionen.client}`);
  const session = await connect(optionen);
  console.log(`Angemeldet: ${session.serverInfo}\n`);

  // --- Stufe 1: Tabellen -------------------------------------------------
  console.log("Tabellen der Datenbank 31 (GTN):");
  const tabellen = await session.query("GTN", ["31", "20", "0"]);
  for (const zeile of tabellen.rows) console.log(`    ${zeile[0]} -> ${zeile[2]}`);
  pruefe("zwei Gruppen gefunden", tabellen.rows.length === 2);

  // --- Stufe 2: Liegeplaetze (Gruppe 2) ----------------------------------
  console.log("\nLiegeplaetze (31:1):");
  const plaetze = await session.selectAll({
    table: "31:1",
    fields: ["such", "plbez", "plaktiv", "plstando", "plsort"],
    pageSize: 10,
  });
  const schluessel = plaetze.records.map((r) => r.such);
  // Nur die aktiven zaehlen - das sind die, die die Anwendung anbietet.
  // Die Gesamtzahl waere sproede: Schreibtests legen inaktive Saetze an,
  // und jede Pflege im Mandanten aendert sie ohnehin.
  const aktive = plaetze.records.filter((r) => r.plaktiv === "1").map((r) => r.such);
  console.log(`    ${schluessel.length} Saetze, davon ${aktive.length} aktiv: ${aktive.slice(0, 5).join(", ")} ...`);
  pruefe("19 aktive Liegeplaetze wie ueber REST", aktive.length === 19, `aktiv: ${aktive.length}`);
  pruefe("WIP.01H enthalten und aktiv", aktive.includes("WIP.01H"));
  pruefe("WIP.11M enthalten und aktiv", aktive.includes("WIP.11M"));
  pruefe(
    "aktiv als 0/1 statt ja/nein (BOOLMODE=NUM)",
    ["0", "1"].includes(plaetze.records[0].plaktiv),
    `Wert: ${JSON.stringify(plaetze.records[0].plaktiv)}`
  );
  pruefe(
    "Seitenweises Lesen hat funktioniert",
    schluessel.length > 10,
    "mehr Saetze als eine Teilmenge"
  );

  // --- Stufe 2: WIP-Datensets (Gruppe 1) ---------------------------------
  console.log("\nWIP-Datensets (31:0):");
  const datensets = await session.selectAll({
    table: "31:0",
    fields: ["such", "pbanr", "pverw", "pteilsw", "pmge", "peinh", "pstatus"],
    pageSize: 5,
  });
  for (const r of datensets.records) {
    console.log(
      `    ${r.such.padEnd(26)} BA ${r.pbanr.padEnd(6)} ${r.pteilsw.padEnd(10)} ` +
        `${r.pmge.padStart(6)} ${r.peinh.padEnd(5)} Status ${r.pstatus}`
    );
  }
  // Keine feste Anzahl pruefen: Das ist Livedaten, die sich durch jede
  // Nutzung der Anwendung aendern. Geprueft wird stattdessen ein
  // bestimmter, bekannter Datensatz.
  pruefe("Datensets gelesen", datensets.records.length > 0, `${datensets.records.length} Saetze`);

  const ba1479 = datensets.records.find((r) => r.such === "WIP.1479.20260914135157");
  pruefe("Datensatz (155,31,0) gefunden", Boolean(ba1479));
  if (ba1479) {
    pruefe("BA-Nummer stimmt", ba1479.pbanr === "1479", ba1479.pbanr);
    pruefe("Verwendung stimmt", ba1479.pverw === "61005865_2", ba1479.pverw);
    pruefe("Erzeugnis stimmt", ba1479.pteilsw === "100481", ba1479.pteilsw);
    pruefe("Status 2 (geprueft)", ba1479.pstatus === "2", ba1479.pstatus);
    pruefe("Menge als Zahl lesbar", Number(ba1479.pmge) === 10, ba1479.pmge);
  }

  // --- Nachkommastellen --------------------------------------------------
  // Datensatz (179,31,0) traegt in Zeile 1 die Menge 2,5 - angelegt ueber
  // die REST-Route, gelesen hier ueber EDP. Der beste Beleg dafuer, dass
  // NUMMODE=RAW den Dezimalpunkt bringt.
  console.log("\nGefilterte Abfrage mit Nachkommastelle (pbanr=1497):");
  const gefiltert = await session.selectAll({
    table: "31:0",
    criteria: "pbanr=1497",
    fields: ["such", "pbanr", "ipmgvb", "iplgpl"],
  });
  for (const r of gefiltert.records) {
    console.log(`    ${r.such} mgvb=${JSON.stringify(r.ipmgvb)} lgpl=${JSON.stringify(r.iplgpl)}`);
  }
  pruefe("Selektionskriterium greift", gefiltert.records.length === 1, `${gefiltert.records.length} Saetze`);

  const menge = gefiltert.records[0]?.ipmgvb ?? "";
  pruefe("Menge 2,5 kommt als 2.500 an", Number(menge) === 2.5, JSON.stringify(menge));
  pruefe("kein Dezimalkomma dank NUMMODE=RAW", !menge.includes(","));
  pruefe(
    "Liegeplatz aus der Erfassung gelesen",
    gefiltert.records[0]?.iplgpl === "WIP.03M",
    JSON.stringify(gefiltert.records[0]?.iplgpl)
  );

  // --- Stufe 3: Schreiben ------------------------------------------------
  // Nur auf ausdrueckliche Anforderung: Ein Rauchtest, der ungefragt in ein
  // ERP schreibt, waere keine gute Idee.
  if (process.argv.includes("--write")) {
    console.log("\nSchreibtest (Liegeplatz anlegen und aendern):");
    // Eindeutiger Schluessel je Lauf. abas laesst in dieser Gruppe
    // gleichnamige Saetze zu, und ein fester Schluessel haeuft bei
    // wiederholten Laeufen Doppel an - dann prueft man am Ende den
    // falschen Satz. (Genau das ist beim ersten Versuch passiert.)
    const schluessel = `WIP.TEST.${Date.now().toString().slice(-8)}`;

    // plaktiv=0: Der Satz ist inaktiv und taucht damit in der Auswahl der
    // WIP-Anwendung nicht auf - ein Testdatensatz soll sich nicht in die
    // Oberflaeche schleichen.
    const angelegt = await session.edit(
      () => session.createRecord("31:1"),
      async (editor) => {
        await editor.setField("such", schluessel);
        await editor.setField("plbez", "Testsatz aus abas-edp");
        await editor.setField("plaktiv", "0");
        await editor.setField("plsort", "999");
      }
    );
    console.log(`    angelegt: ${angelegt.ref} (Identnummer ${angelegt.num})`);
    pruefe("Referenz zurueckgeliefert", /^\(\d+,\d+,\d+\)$/.test(angelegt.ref), angelegt.ref);

    const nachAnlage = await session.selectAll({
      table: "31:1",
      criteria: `such=${schluessel}`,
      fields: ["such", "plbez", "plaktiv", "plsort"],
    });
    pruefe("Satz wiedergefunden", nachAnlage.records.length === 1, `${nachAnlage.records.length} Treffer`);
    pruefe("Bezeichnung gespeichert", nachAnlage.records[0]?.plbez === "Testsatz aus abas-edp");
    pruefe("inaktiv, taucht nicht in der Auswahl auf", nachAnlage.records[0]?.plaktiv === "0");

    await session.edit(
      () => session.editRecord(angelegt.ref, { by: "REF" }),
      async (editor) => editor.setField("plbez", "Testsatz geaendert")
    );

    const nachAenderung = await session.selectAll({
      table: "31:1",
      criteria: `such=${schluessel}`,
      fields: ["such", "plbez"],
    });
    pruefe("Aenderung gespeichert", nachAenderung.records[0]?.plbez === "Testsatz geaendert", nachAenderung.records[0]?.plbez);

    console.log(`    Hinweis: Der Testsatz ${schluessel} bleibt stehen (inaktiv).`);
  }

  await session.close();

  console.log("");
  if (fehler === 0) {
    console.log("Rauchtest bestanden - EDP liefert dieselben Daten wie die REST-Middleware.");
  } else {
    console.log(`${fehler} Pruefung(en) fehlgeschlagen.`);
    process.exitCode = 1;
  }
}

main().catch((f) => {
  console.error(`\nFEHLGESCHLAGEN: ${f.message}`);
  process.exitCode = 1;
});
