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

const wip = await session.selectAll({
  table: "31:0",
  criteria: "pbanr=1497",
  fields: ["such", "pbanr", "pmge", "peinh"],
});

for (const satz of wip.records) {
  console.log(satz.such, Number(satz.pmge), satz.peinh);
}

await session.close(); // gibt die Lizenz frei
```

`select()` liefert eine Teilmenge und meldet über `hasMore`, ob weitere
folgen; `next()` holt die nächste. `selectAll()` nimmt einem das ab und
liest durch — nur verwenden, wenn das Ergebnis in den Speicher passt.

Sind Feldnamen angegeben, gibt es das Ergebnis zusätzlich als `records`
(ein Objekt je Zeile). Die Zuordnung läuft über die Position: Der Server
liefert je angefordertem Feld genau eine Spalte, auch für ungültige
Feldnamen — ein Tippfehler verschiebt also nichts, er liefert eine leere
Spalte.

## Darstellungsoptionen

Nach der Anmeldung setzt das Paket drei Optionen, die nur die
Schreibweise ändern, nicht den Informationsgehalt:

| Option | Wert | Wirkung |
|---|---|---|
| `NUMMODE` | `RAW` | Zahlen mit Dezimal**punkt** — `Number()` funktioniert direkt |
| `BOOLMODE` | `NUM` | `0`/`1` statt `ja`/`nein` |
| `DATEMODE` | `SORT` | sortierbares, sprachunabhängiges Datum |

`NUMMODE` ist der wichtigste: Ohne ihn kommen Zahlen in der Schreibweise
der Bediensprache, also mit Komma — und `Number("2,5")` ist `NaN`.

Bewusst **nicht** vorgegeben sind `ENUMMODE` und `VERWMODE`, weil dort
eine echte Abwägung ansteht. `VERWMODE=SW` liefert das Suchwort eines
Verweises (lesbar, aber nicht eindeutig), `VERWMODE=REF` die eindeutige
Satzreferenz wie `(4711,2,0)`. Für die WIP-Anwendung ist `SW` richtig,
weil genau das angezeigt und auch zurückgeschrieben wird:

```ts
import { connect, DEFAULT_OPTIONS } from "@sschweimler/abas-edp";

const session = await connect({
  /* ... */
  options: { ...DEFAULT_OPTIONS, VERWMODE: "SW" },
});
```

Mit `options: {}` bleiben die abas-Vorgaben unangetastet.

## Schreiben

```ts
const { ref, num } = await session.edit(
  () => session.createRecord("31:1"),
  async (editor) => {
    await editor.setField("such", "WIP.12A");
    await editor.setField("plbez", "Halle 12, Platz A");
    await editor.insertRow();                    // Zeile im Tabellenteil
    await editor.setField("ipmgvb", "2.5", 1);   // Feld in Zeile 1
  }
);
// ref = "(186,31,0)", num = "34"
```

`edit()` ist der empfohlene Weg: Es speichert bei Erfolg und bricht bei
einem Fehler ab. Eine offen gebliebene Editoraktion blockiert sonst die
ganze Sitzung — abas lässt bei Exklusiveditoren keinen zweiten zu, und
der Folgefehler tritt dann weit entfernt von seiner Ursache auf.

Zum Ändern `session.editRecord("(186,31,0)")` statt `createRecord`.

Zwei Dinge, die die Spezifikation nicht hergibt und die am System
ermittelt wurden:

- **`NEW` bekommt nur die Gruppe.** Objektbezugsart und Objektbezug
  bleiben leer; sie dienen dem Anlegen *mit Bezug* auf ein bestehendes
  Objekt. Das in der Doku zum Kommando `EDI` erwähnte `EMPTY` gilt nicht
  für `NEW` — dort antwortet der Server mit „EMPTY: nicht gefunden".
- **`GTS` antwortet mit einer Datenmenge, nicht mit `ACK`** — je
  Eigenschaft eine `D`-Zeile. Wer auf ein `ACK` wartet, wartet endlos.
  Die Referenz eines neu angelegten Satzes steht erst **nach** dem
  `COM` darin; vorher liefert `REF` den Wert `(0,0,0)`.

Zahlen werden beim Schreiben **nicht** umformatiert: Welche Schreibweise
der Server erwartet, hängt an `NUMMODE`. Mit der Vorgabe `RAW` ist es der
Dezimalpunkt.

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

Umgesetzt sind **Lesen und Schreiben**: verbinden, anmelden,
Darstellungsoptionen setzen, Kommandos mit `ACK`/`NAK`-Antwort,
Selektionen (`EXQ`) samt seitenweisem Weiterlesen (`GNR`), Datenmengen
einschließlich Fortsetzungssätzen, Editoraktionen zum Anlegen und Ändern
(`NEW`, `UPD`, `SFV`, `RIN`, `RDL`, `GTS`, `COM`, `CAN`), abmelden.

Am echten System geprüft gegen abas 2101r8n20p31 / EDP 3.55: Die
gelesenen Datensätze stimmen mit denen überein, die dieselbe Anwendung
über die REST-Middleware sieht — gleiche Anzahl, gleiche Werte, und eine
über REST geschriebene Menge von 2,5 kommt über EDP als `2.500` zurück.

Noch nicht umgesetzt: Infosystem-Aufrufe, Transaktionen (`TA`), Sperren
(`LCK`), Freitextfelder (`SFT`), Dialogbeantwortung (`DLG`),
Fortsetzungssätze beim Senden.

Die Wildcard-Syntax für Selektionskriterien ist noch offen: `such=WIP.*`
und `such=WIP.@` liefern beide nichts, während `pbanr=1497` einwandfrei
greift. Kriterien funktionieren also, nur die Platzhalterform ist noch
nicht ermittelt.

## Entwicklung

```bash
npm install
npm test          # baut und prüft gegen einen Mock-Server, kein ERP nötig
ABAS_PASSWORD=... npm run smoke -- --host abas-server --client entw
```

Zwei Eigenheiten des eingebauten Test-Runners, die beide schon einmal
einen CI-Lauf gekostet haben:

- `node --test` wird **ohne Pfadangabe** aufgerufen. Ein Verzeichnis als
  Argument durchsucht Node bis Version 20, ab Version 22 versucht es
  stattdessen, den Pfad als Modul zu laden — und scheitert.
- Unter `test/` liegen ausschließlich Dateien mit der Endung `.test.js`.
  Hilfsprogramme — der Mock-Server und der Rauchtest gegen ein echtes
  System — stehen in `scripts/`, weil Node ab Version 20 **jede**
  `.js`-Datei unterhalb von `test/` als Testdatei betrachtet.

Die CI prüft deshalb gegen Node 18, 20 und 22.

Veröffentlicht wird über einen Versions-Tag:

```bash
npm version patch
git push --follow-tags
```
