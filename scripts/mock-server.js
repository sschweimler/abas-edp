"use strict";

const net = require("node:net");

/**
 * Mock-EDP-Server fuer die Tests.
 *
 * Bildet den dokumentierten Dialog nach und deckt gezielt die Faelle ab,
 * die sich sonst erst am Produktivsystem zeigen: Begruessung, CHM vor LGN
 * ("Login Version 2"), maskierte Sonderzeichen, DC-Fortsetzungszeilen und
 * eingestreute Statussaetze.
 */
function startMockServer(options = {}) {
  const { requireChm = true } = options;

  const server = net.createServer((socket) => {
    let buffer = "";
    let mandant = null;
    let loggedIn = false;
    /** Per SET gesetzte Darstellungsoptionen. */
    const optionen = {};
    let letzteAbfrage = null;
    /** Offene Editoraktion - es darf nur eine geben (Exklusiveditor). */
    let editor = null;
    let gespeichert = 0;
    let zuletztGespeichert = null;

    const send = (line) => socket.write(Buffer.from(line + "\n", "latin1"));

    send("S|0|3|VERSION|2797|");

    socket.on("data", (data) => {
      buffer += data.toString("latin1");
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        const fields = line.split("|");
        const command = fields[0];
        const tid = fields[1];

        if (command === "CHM") {
          mandant = fields[2];
          send(`S|0|EDP Version 3.55, abas Version 2101r8n20p31|HELLO|2797|`);
          send(`ACK|${tid}|Mandant wurde gewechselt. Neuer Mandant: ${mandant}|`);
          continue;
        }

        if (command === "LGN") {
          if (requireChm && !mandant) {
            send(`E|${tid}|LGN: Login Version 2 erwartet CHM als ersten Request.|ERROR|8248|||||`);
            send(`NAK|${tid}|Aktion jetzt nicht moeglich|3886||`);
            send(`END|${tid}|Vorzeitiges Programmende|102|`);
            socket.end();
            return;
          }
          if (fields[2] === "falsch") {
            send(`NAK|${tid}|Ungueltiges Passwort|17|LGN|`);
            socket.end();
            return;
          }
          loggedIn = true;
          send(`ACK|${tid}|Logon erfolgreich|`);
          continue;
        }

        if (!loggedIn) {
          socket.end();
          return;
        }

        if (command === "SET") {
          optionen[fields[2]] = fields[3];
          send(`ACK|${tid}|Option gesetzt|`);
          continue;
        }

        if (command === "EXQ") {
          // Feldliste steht im zweiten Nutzfeld; je angefordertem Feld
          // liefert der Server genau eine Spalte.
          letzteAbfrage = { tid, seite: 0 };
          send(`BOD|${tid}|2|4|`);
          // Zahl mit Nachkommastelle - in RAW mit Punkt, sonst mit Komma.
          const zahl = optionen.NUMMODE === "RAW" ? "2.5" : "2,5";
          send(`D|${tid}|WIP.1479.20260914135157|1479|${zahl}|`);
          send(`D|${tid}|WIP.1489.20260914135318|1489|1|`);
          // eof=0: es gibt eine zweite Teilmenge
          send(`EOD|${tid}|1|2|0|`);
          continue;
        }

        if (command === "GNR") {
          if (!letzteAbfrage) {
            send(`NAK|${tid}|Keine Abfrage aktiv|1||`);
            continue;
          }
          letzteAbfrage.seite += 1;
          const zielTid = fields[1] || letzteAbfrage.tid;
          send(`BOD|${zielTid}|1|4|`);
          send(`D|${zielTid}|WIP.1494.20260914152223|1494|1|`);
          // eof=1: fertig
          send(`EOD|${zielTid}|1|1|1|`);
          continue;
        }

        // --- Editoraktionen ------------------------------------------
        if (command === "NEW" || command === "UPD") {
          if (editor) {
            // Exklusiveditor: ein zweiter ist nicht erlaubt
            send(`NAK|${tid}|Es ist bereits ein Editor aktiv|4711||`);
            continue;
          }
          editor = { tid, felder: {}, zeilen: 0, aktion: command };
          send(`ACK|${tid}|Editor geoeffnet|`);
          continue;
        }

        if (command === "SFV") {
          if (!editor || editor.tid !== tid) {
            send(`NAK|${tid}|Keine Editoraktion mit dieser Aktions-ID|4712||`);
            continue;
          }
          const zeile = fields[2] || "0";
          const feld = fields[3];
          const wert = fields[4];
          if (feld === "gibtesnicht") {
            send(`E|${tid}|Das Feld gibtesnicht existiert nicht.|ERROR|1|||||`);
            send(`NAK|${tid}|Ungueltiger Feldname|1361||`);
            continue;
          }
          editor.felder[`${zeile}:${feld}`] = wert;
          send(`ACK|${tid}|Feld gesetzt|`);
          continue;
        }

        if (command === "RIN") {
          if (!editor || editor.tid !== tid) {
            send(`NAK|${tid}|Keine Editoraktion|4712||`);
            continue;
          }
          editor.zeilen += 1;
          send(`ACK|${tid}|Zeile eingefuegt|`);
          continue;
        }

        // GTS antwortet mit einer Datenmenge, NICHT mit ACK - je
        // Eigenschaft eine D-Zeile. Genau das hat der Mock frueher falsch
        // nachgebildet und damit einen Fehler in der Bibliothek gedeckt.
        if (command === "GTS") {
          const bezug = editor && editor.tid === tid ? editor : zuletztGespeichert;
          if (!bezug) {
            send(`NAK|${tid}|Keine Editoraktion|4712||`);
            continue;
          }
          const werte = {
            NUMROWS: String(bezug.zeilen),
            ACTION: bezug.aktion,
            MODIFIED: "1",
            // Bei der Neuanlage vor dem Speichern (0,0,0), danach echt.
            REF: bezug.ref || "(0,0,0)",
            NUM: bezug.num || "",
          };
          send(`BOD|${tid}|${Object.keys(werte).length}||`);
          for (const [name, wert] of Object.entries(werte)) send(`D|${tid}|${name}|${wert}|`);
          send(`EOD|${tid}|1|${Object.keys(werte).length}|1|`);
          continue;
        }

        if (command === "COM") {
          if (!editor || editor.tid !== tid) {
            send(`NAK|${tid}|Keine Editoraktion|4712||`);
            continue;
          }
          gespeichert += 1;
          editor.ref = `(${200 + gespeichert},31,0)`;
          editor.num = String(1000 + gespeichert);
          zuletztGespeichert = editor;
          editor = null;
          // Die ACK-Antwort traegt nur die Meldung, nicht die Referenz.
          send(`ACK|${tid}|Daten erfolgreich gespeichert|`);
          continue;
        }

        if (command === "CAN") {
          editor = null;
          send(`ACK|${tid}|Aktion abgebrochen|`);
          continue;
        }

        if (command === "GTN") {
          send(`BOD|${tid}|||`);
          send(`S|${tid}|Lese Tabellen ...|`);
          send(`D|${tid}|Kunde:Kunde|Kunde (Kunde)|0:1|`);
          // Sonderzeichen im Feldwert
          send(`D|${tid}|Artikel|Bez mit \\| und \\n und \\\\|2:1|`);
          // Ueberlange Zeile: endet ohne Trenner, zwei DC-Saetze folgen
          send(`D|${tid}|Lieferant|Anfang`);
          send(`DC|${tid}|-Mitte`);
          send(`DC|${tid}|-Ende|1:1|`);
          send(`EOD|${tid}|1|3|0|`);
          continue;
        }

        if (command === "END") {
          send("END|0|Ende durch Client angefordert|0|");
          socket.end();
          return;
        }

        send(`NAK|${tid}|Unbekanntes Kommando ${command}|99||`);
      }
    });

    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startMockServer };
