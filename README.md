# @sschweimler/abas-edp

Client für die **EDP-Schnittstelle** von abas ERP — das textbasierte
Protokoll über TCP, Standardport 6550.

Ohne Java, ohne abas-Bibliotheken, **ohne Laufzeitabhängigkeiten**: TCP und
ISO-8859-1 beherrscht Node selbst. Damit läuft das Paket überall, wo Node
läuft, und ist — anders als AJO — nicht an mandantenspezifisch erzeugte
Jar-Dateien gebunden, die bei jeder Schemaänderung neu erstellt werden
müssen.

## Einordnung

abas bietet drei Wege von außen:

| Weg | Bindung | Diese Anwendung |
|---|---|---|
| REST-Middleware | eigener Dienst, generisches Objektmodell | ersetzbar durch dieses Paket |
| AJO (Java) | mandantenspezifische Jars, JVM | für Node keine Option |
| **EDP** | nur TCP, schemafrei | Grundlage dieses Pakets |

Die EDP-Schnittstelle gehört laut Onlinehilfe (Kapitel 300.17) zum
Kernsystem, ist offengelegt und benötigt keine zusätzliche Lizenz. Eine
offene Verbindung belegt allerdings — wie jeder Zugriff auf abas — eine
Benutzerlizenz. Sitzungen deshalb schließen, wenn sie nicht gebraucht
werden.

## Verwendung

```ts
import { connect } from "@sschweimler/abas-edp";

const session = await connect({
  host: "abas-server",
  client: "entw",
  password: process.env.ABAS_PASSWORD!,
  appName: "meine-anwendung", // erscheint in der abas-Benutzerliste
});

const tabellen = await session.query("GTN", ["31", "20", "0"]);
for (const zeile of tabellen.rows) {
  console.log(zeile[0], zeile[2]);
}

await session.close(); // gibt die Lizenz frei
```

### Mitschnitt

```ts
const session = await connect({
  /* ... */
  logger: (richtung, text) => console.log(richtung, text),
});
```

Das Passwort wird im Anmeldesatz durch `***` ersetzt — der Mitschnitt darf
weitergereicht werden.

## Was das Paket abnimmt

Die Tücken des Protokolls stecken nicht in den Kommandos, sondern im
Drumherum. Erledigt sind:

- **Satzgrenzen und Kodierung** — Linefeed als Trenner, ISO-8859-1, CRLF
  wird toleriert.
- **Maskierung** — `|`, Zeilenumbruch, Wagenrücklauf, Null und Backslash in
  beide Richtungen.
- **Fortsetzungssätze** — Sätze über 4096 Byte kommen als `D` plus
  beliebig viele `DC` an. Das erste Feld eines `DC` ist kein neues Feld,
  sondern der Rest des abgeschnittenen vorherigen. Wer das übersieht, baut
  stillschweigend falsche Datensätze zusammen; der Fehler zeigt sich erst
  bei langen Feldinhalten.
- **Anmeldung** — Installationen mit „Login Version 2" verlangen `CHM` als
  ersten Request und weisen ein direktes `LGN` ab. In der Spezifikation
  steht das nur als Nebensatz beim Mandantenfeld von `LGN`.
- **Fehlermeldungen** — der `NAK`-Satz trägt oft nur eine Floskel
  („Aktion jetzt nicht möglich"), während der unmittelbar davor gesendete
  `E`-Satz den Grund nennt. Beide landen in der Fehlermeldung.
- **Eingestreute Sätze** — `S`, `P`, `CN` und `WBA` dürfen jederzeit
  zwischen Anfrage und Antwort auftauchen, ohne die Auswertung zu stören.

## Stand

Umgesetzt ist die Sitzungsebene: verbinden, anmelden, Kommandos mit
`ACK`/`NAK`-Antwort, Datenmengen lesen (`BOD`/`D`/`DC`/`EOD`), abmelden.
Am echten System geprüft gegen abas 2101r8n20p31, EDP 3.55.

Noch nicht umgesetzt: Selektionen mit `EXQ` und Weiterlesen mit `GNR`,
Editorkommandos zum Schreiben, Infosystem-Aufrufe, Transaktionen,
Dialogbeantwortung (`DLG`), Fortsetzungssätze beim **Senden**.

## Entwicklung

```bash
npm install
npm test          # baut und prüft gegen einen Mock-Server, kein ERP nötig
ABAS_PASSWORD=... npm run smoke -- --host abas-server --client entw
```

Unter `test/` liegen ausschließlich Dateien mit der Endung `.test.js`.
Hilfsprogramme — der Mock-Server und der Rauchtest gegen ein echtes
System — stehen bewusst in `scripts/`: Node betrachtet ab Version 20
**jede** `.js`-Datei unterhalb von `test/` als Testdatei und würde sie
sonst mitlaufen lassen.

Veröffentlicht wird über einen Versions-Tag:

```bash
npm version patch
git push --follow-tags
```
