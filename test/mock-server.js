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
