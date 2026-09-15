import os from "node:os";
import { EdpConnection, type ConnectionOptions } from "./connection";
import { appendContinuation, type EdpRecord } from "./record";
import { EdpError } from "./errors";
import { EdpEditor } from "./editor";

export interface LoginOptions extends ConnectionOptions {
  /** Mandant, z. B. "entw". */
  client: string;
  /** abas-Passwort. Darf laut Spezifikation nicht leer sein. */
  password: string;
  /**
   * Name der Anwendung. Erscheint in der abas-Benutzerliste und macht die
   * Sitzung dort zuordenbar - im Betrieb Gold wert, wenn jemand fragt, wer
   * da eine Lizenz belegt.
   */
  appName?: string;
  /** Rechnername, ebenfalls fuer die Benutzerliste. */
  hostname?: string;
  /**
   * Protokollversion, die der Client mindestens benoetigt. Nur erhoehen,
   * wenn tatsaechlich neuere Kommandos verwendet werden.
   */
  clientVersion?: string;
  /**
   * Darstellungsoptionen, die nach der Anmeldung per SET gesetzt werden.
   *
   * Die Vorgabe stellt auf maschinenlesbare, sprachunabhaengige Formate um
   * (siehe DEFAULT_OPTIONS) - fuer ein Programm ist das fast immer das
   * Richtige. Ein leeres Objekt uebergeben, um die abas-Vorgaben zu
   * behalten.
   */
  options?: Record<string, string>;
}

/**
 * Darstellungsoptionen, die dieses Paket nach der Anmeldung setzt.
 *
 * Alle drei sind verlustfrei: Sie aendern nur die Schreibweise, nicht den
 * Informationsgehalt. Deshalb sind sie als Vorgabe vertretbar.
 *
 * - NUMMODE=RAW liefert Zahlen "minimal formatiert ... ein Dezimalpunkt
 *   bei Dezimalzahlen". Ohne das kommen Zahlen in der Schreibweise der
 *   Bediensprache, also mit Komma - und Number("0,5") ist NaN. Genau
 *   dieser Fallstrick hat beim REST-Weg schon einmal zugeschlagen.
 * - BOOLMODE=NUM liefert 0/1 statt "ja"/"nein".
 * - DATEMODE=SORT liefert ein sortierbares, sprachunabhaengiges Datum.
 *
 * Bewusst NICHT vorgegeben sind ENUMMODE und VERWMODE: Dort steht eine
 * echte Abwaegung an (Lesbarkeit gegen Eindeutigkeit), die der Aufrufer
 * treffen sollte. VERWMODE=SW liefert das Suchwort eines Verweises,
 * VERWMODE=REF die eindeutige Satzreferenz.
 */
export const DEFAULT_OPTIONS: Record<string, string> = {
  NUMMODE: "RAW",
  BOOLMODE: "NUM",
  DATEMODE: "SORT",
};

export interface SelectOptions {
  /**
   * Tabelle, z. B. "WIP-Bestand:WIP-Bestand" oder "31:0". Die Namen
   * liefert das Kommando GTN.
   */
  table: string;
  /**
   * Selektionsbedingungen in abas-$-Notation ohne den Tabellennamen,
   * z. B. "such=WIP.1479@" oder "@sort=such".
   */
  criteria?: string;
  /**
   * Zu liefernde Felder, in dieser Reihenfolge. Leer bedeutet: alle Felder
   * der Selektionsleiste. Ein vorangestelltes Minus schliesst ein Feld
   * aus.
   */
  fields?: string[];
  /** Saetze je Antwort; der Rest wird mit next() nachgeholt. */
  pageSize?: number;
  /** Zu ueberspringende Saetze am Anfang des Ergebnisses. */
  offset?: number;
  /** Abbruch der Abfrage nach dieser Zeit, in Millisekunden. */
  queryTimeoutMs?: number;
  /** Metadatenzeilen (DM) vor den Daten anfordern. */
  withMeta?: boolean;
  /** Sprache, in der die Feldnamen eingetragen sind. */
  fieldLanguage?: "de" | "en";
}

/** Ergebnis einer Datenmengen-Abfrage (BOD ... D ... EOD). */
export interface Dataset {
  /** Datenzeilen, DC-Fortsetzungen sind bereits zusammengefuegt. */
  rows: string[][];
  /** Wurden alle Daten des Datasets uebertragen? */
  ok: boolean;
  /** Gibt es beim Weiterlesen mit GNR noch mehr? */
  hasMore: boolean;
  /** Metadatenzeilen (DM), sofern angefordert. */
  meta: string[][];
  /**
   * Die angeforderten Feldnamen, sofern welche angegeben waren. Der Server
   * liefert je angefordertem Feld genau ein Feld zurueck - auch fuer
   * ungueltige Feldnamen -, sodass die Zuordnung ueber die Position
   * verlaesslich ist.
   */
  fields?: string[];
  /** Zeilen als Objekte, sofern Feldnamen angegeben waren. */
  records?: Record<string, string>[];
}

/** Saetze, die der Server jederzeit einstreuen darf. */
const INTERLEAVED = new Set(["S", "E", "P", "CN", "WBA"]);

/**
 * Angemeldete EDP-Sitzung.
 *
 * Der Anmeldeablauf ist nicht der aus der Kurzfassung der Spezifikation:
 * Installationen mit "Login Version 2" verlangen CHM als ersten Request
 * und weisen ein direktes LGN ab. Das steht in der Doku nur als Nebensatz
 * beim Mandantenfeld von LGN, kostet aber sonst eine Runde Ratlosigkeit -
 * deshalb wird hier grundsaetzlich erst CHM gesendet.
 */
export class EdpSession {
  /** Aktions-ID der zuletzt gestarteten Abfrage, fuer das Weiterlesen. */
  private lastQueryTid: number | null = null;
  /** Feldliste der zuletzt gestarteten Selektion, fuer die Zuordnung. */
  private lastFields: string[] | undefined;

  private constructor(
    private readonly connection: EdpConnection,
    readonly client: string,
    readonly serverInfo: string
  ) {}

  /** Baut die Verbindung auf und meldet an. */
  static async open(options: LoginOptions): Promise<EdpSession> {
    if (!options.password) {
      throw new Error("Passwort fehlt - das EDP-Protokoll laesst kein leeres Passwort zu");
    }
    const connection = new EdpConnection(options);
    await connection.connect();

    try {
      // Der Server meldet sich nach dem Verbindungsaufbau von sich aus.
      await connection.read("Begruessung");

      // Mandant bekannt geben.
      const chmTid = connection.takeTid();
      connection.send("CHM", chmTid, [options.client]);
      await expectAck(connection, "Mandantenwechsel");

      // Anmelden.
      const lgnTid = connection.takeTid();
      connection.send(
        "LGN",
        lgnTid,
        [
          options.password,
          options.client,
          options.clientVersion ?? "1.0",
          options.hostname ?? os.hostname(),
          options.appName ?? "abas-edp",
          "", // Bildschirmkennung
          "", // Client-IP
          "", // Username - leer bedeutet Anmeldung ueber das ERP-Passwort
          "", // Login-Typ
          "USER", // Sessionmodus
          "", // Lizenzart, derzeit ohne Funktion
        ],
        0 // Feldindex des Passworts, damit es nicht im Mitschnitt landet
      );
      const ack = await expectAck(connection, "Anmeldung");
      const session = new EdpSession(connection, options.client, ack.fields[0] ?? "");

      // Darstellungsoptionen erst nach der Anmeldung - vorher nimmt der
      // Server keine SET-Kommandos an.
      const wanted = options.options ?? DEFAULT_OPTIONS;
      for (const [name, value] of Object.entries(wanted)) {
        await session.setOption(name, value);
      }

      return session;
    } catch (error) {
      connection.destroy();
      throw error;
    }
  }

  /** Ist die zugrundeliegende Verbindung bereits geschlossen? */
  get isClosed(): boolean {
    return this.connection.isClosed;
  }

  /** Setzt eine Darstellungsoption (SET), z. B. VERWMODE auf "SW". */
  async setOption(name: string, value: string): Promise<void> {
    await this.command("SET", [name, value]);
  }

  // --- interne Varianten ohne Ausschluss ---------------------------------
  // Werden von Methoden aufgerufen, die den Ausschluss bereits halten.

  private async commandRaw(command: string, fields: unknown[]): Promise<EdpRecord> {
    const tid = this.connection.takeTid();
    this.connection.send(command, tid, fields);
    return expectAck(this.connection, command);
  }

  private async queryRaw(command: string, fields: unknown[]): Promise<Dataset> {
    const tid = this.connection.takeTid();
    this.connection.send(command, tid, fields);
    this.lastQueryTid = tid;
    return this.readDataset(command);
  }

  private async selectRaw(options: SelectOptions): Promise<Dataset> {
    const selectString = options.criteria
      ? `${options.table},${options.criteria}`
      : options.table;

    const dataset = await this.queryRaw("EXQ", [
      selectString,
      options.fields?.join(",") ?? "",
      options.pageSize ?? "",
      options.offset ?? "",
      "", // Edit-TID, nur bei feldbezogener Selektion
      "", // Zeilenangabe
      "", // Feldname
      options.queryTimeoutMs ?? "",
      options.withMeta ? "1" : "0",
      options.fieldLanguage ?? "",
      "", // Tabellenname - steckt bereits im Selektstring
    ]);

    this.lastFields = options.fields;
    return withFields(dataset, options.fields);
  }

  private async nextRaw(): Promise<Dataset> {
    if (this.lastQueryTid === null) {
      throw new Error("Kein Weiterlesen moeglich - es wurde noch keine Abfrage ausgefuehrt");
    }
    this.connection.send("GNR", this.lastQueryTid, []);
    const dataset = await this.readDataset("GNR");
    return withFields(dataset, this.lastFields);
  }

  // --- oeffentliche Schnittstelle ----------------------------------------

  /**
   * Fuehrt ein Kommando aus, das mit ACK oder NAK beantwortet wird.
   * Liefert den ACK-Satz.
   */
  command(command: string, fields: unknown[] = []): Promise<EdpRecord> {
    return this.connection.exclusive(() => this.commandRaw(command, fields));
  }

  /**
   * Fuehrt ein Kommando aus, das mit einer Datenmenge beantwortet wird
   * (BOD, beliebig viele D/DC, EOD).
   */
  query(command: string, fields: unknown[] = []): Promise<Dataset> {
    return this.connection.exclusive(() => this.queryRaw(command, fields));
  }

  /**
   * Fuehrt eine Selektion aus (EXQ).
   *
   * Der Selektstring wird in der klassischen Form "Tabelle,Kriterien"
   * zusammengesetzt. Ab EDP 3.55 koennte die Tabelle auch im letzten Feld
   * stehen - die klassische Form funktioniert aber auch mit aelteren
   * Servern, und der Unterschied ist sonst keiner.
   */
  select(options: SelectOptions): Promise<Dataset> {
    return this.connection.exclusive(() => this.selectRaw(options));
  }

  /**
   * Holt die naechste Teilmenge einer Abfrage (GNR).
   *
   * Ohne Aktions-ID setzt der Server die zuletzt benutzte Abfrage fort;
   * hier wird sie trotzdem mitgegeben, damit das Verhalten auch dann
   * eindeutig bleibt, wenn zwischendurch andere Kommandos liefen.
   */
  next(): Promise<Dataset> {
    return this.connection.exclusive(() => this.nextRaw());
  }

  /**
   * Selektiert und liefert alle Saetze, ueber beliebig viele Teilmengen
   * hinweg. Nur verwenden, wenn das Ergebnis in den Speicher passt -
   * sonst select()/next() von Hand paginieren.
   *
   * Laeuft als EIN exklusiver Vorgang: GNR setzt serverseitig die zuletzt
   * benutzte Abfrage fort, also darf zwischen EXQ und den GNR-Aufrufen
   * keine andere Abfrage dazwischenkommen.
   */
  selectAll(options: SelectOptions): Promise<Dataset> {
    return this.connection.exclusive(async () => {
      const first = await this.selectRaw(options);
      const rows = [...first.rows];
      let page = first;

      while (page.hasMore) {
        page = await this.nextRaw();
        rows.push(...page.rows);
      }

      return withFields({ ...first, rows, hasMore: false }, options.fields);
    });
  }

  private async readDataset(action: string): Promise<Dataset> {
    const rows: string[][] = [];
    const meta: string[][] = [];
    const messages: string[] = [];
    let current: string[] | null = null;

    for (;;) {
      const record = await this.connection.read(`${action}-Daten`);

      switch (record.command) {
        case "D":
          // Bewusst NICHT hier normalisieren: Eine DC-Fortsetzung wird an
          // das letzte Feld angehaengt, und ein vorzeitig entferntes
          // Leerzeichen an der Bruchstelle waere fuer immer weg. Getrimmt
          // wird erst, wenn die Zeile vollstaendig ist (siehe EOD).
          current = [...record.fields];
          rows.push(current);
          break;

        case "DC":
          if (!current) throw new Error("DC-Satz ohne vorangehenden D-Satz");
          appendContinuation(current, record);
          break;

        case "DM":
          meta.push([...record.fields]);
          break;

        case "EOD":
          return {
            // Jetzt sind alle Fortsetzungen eingearbeitet, also kann
            // normalisiert werden (Externdarstellung ist auf Feldbreite
            // aufgefuellt, siehe ConnectionOptions.trimValues).
            rows: rows.map((zeile) => zeile.map((feld) => this.connection.normalize(feld))),
            ok: record.fields[0] === "1",
            hasMore: record.fields[2] === "0",
            meta,
          };

        case "NAK":
          throw new EdpError(action, record, messages);

        case "BOD":
          break;

        default:
          if (record.command === "E") messages.push(record.fields[0] ?? "");
          else if (!INTERLEAVED.has(record.command)) {
            // Unbekannte Saetze nicht stillschweigend verschlucken, aber
            // auch nicht die Abfrage abbrechen.
            messages.push(`unerwarteter Satz ${record.command}`);
          }
      }
    }
  }

  /**
   * Beginnt eine Neuanlage (NEW) und liefert die offene Editoraktion.
   *
   * Die Aktion muss mit commit() oder cancel() beendet werden - sonst
   * bleibt sie offen und blockiert bei Exklusiveditoren jede weitere.
   * Bequemer und sicherer ist edit().
   */
  async createRecord(table: string): Promise<EdpEditor> {
    const tid = this.connection.takeTid();
    // NEW|TID|Datenbank[:Gruppe]|[Objektbezugsart]|[Objektbezug]|
    //
    // Objektbezugsart und Objektbezug bleiben leer. Sie dienen dem Anlegen
    // MIT Bezug auf ein bestehendes Objekt; fuer eine schlichte Neuanlage
    // gibt es kein Bezugsobjekt. Am echten System geprueft: "31:1" allein
    // wird angenommen ("Objekt ist zur Bearbeitung geladen"), waehrend
    // "REF" mit leerem Bezug mit "Ungültige Objektangabe" (1582)
    // scheitert. Das in der Doku zum Kommando EDI erwaehnte "EMPTY" gilt
    // fuer EDI, nicht fuer NEW - dort quittiert der Server es mit
    // "EMPTY: nicht gefunden".
    return this.connection.exclusive(async () => {
      this.connection.send("NEW", tid, [table]);
      await expectAck(this.connection, `NEW ${table}`);
      return new EdpEditor(this.connection, tid);
    });
  }

  /**
   * Beginnt eine Aenderung (UPD) und liefert die offene Editoraktion.
   *
   * `reference` ist entweder eine Satzreferenz wie "(155,31,0)" - dann
   * `by` auf "REF" lassen - oder eine Identnummer bzw. ein eindeutiges
   * Suchwort mit `by: "NUMSW"`.
   */
  async editRecord(
    reference: string,
    options: { table?: string; by?: "REF" | "NUMSW" } = {}
  ): Promise<EdpEditor> {
    const tid = this.connection.takeTid();
    return this.connection.exclusive(async () => {
      this.connection.send("UPD", tid, [options.table ?? "", options.by ?? "REF", reference]);
      await expectAck(this.connection, `UPD ${reference}`);
      return new EdpEditor(this.connection, tid);
    });
  }

  /**
   * Oeffnet ein Infosystem im Hintergrund und liefert es als Editoraktion.
   *
   * Ablauf danach: Auswahlfelder mit setField() fuellen, den Startbutton
   * mit click("bstart") ausloesen, das Ergebnis mit getFields(felder, "*")
   * lesen und die Aktion mit cancel() schliessen. Ein Infosystem wird
   * nicht gespeichert - COM waere hier falsch.
   *
   * Geoeffnet wird ueber das Tippkommando "Infosystem"
   * (EDI|TID|DO|Infosystem||<Suchwort>|), so wie es auch das mitgelieferte
   * edpinfosys.sh mit seiner Option -n tut. Fuehrt der Mandant dasselbe
   * Suchwort in mehreren Arbeitsbereichen, den Bereich mit angeben -
   * daraus wird "<Suchwort> <Arbeitsbereich>".
   *
   * Achtung: "Infosystem" ist das Tippkommando in der Bediensprache. In
   * einem anderssprachigen Mandanten heisst es anders; dann ueber
   * `typedCommand` den passenden Text setzen.
   */
  async openInfosystem(
    searchword: string,
    options: { workingDir?: string; typedCommand?: string } = {}
  ): Promise<EdpEditor> {
    const argument = options.workingDir ? `${searchword} ${options.workingDir}` : searchword;
    const tid = this.connection.takeTid();
    // EDI|TID|Aktion|Tippkommando||Kommando-Argumente|
    // Das leere Feld zwischen Tippkommando und Argumenten gehoert dazu -
    // ohne es antwortet der Server "Infosystem : kein Suchwort angegeben".
    return this.connection.exclusive(async () => {
      this.connection.send("EDI", tid, ["DO", options.typedCommand ?? "Infosystem", "", argument]);
      await expectAck(this.connection, `Infosystem ${argument}`);
      return new EdpEditor(this.connection, tid);
    });
  }

  /**
   * Fuehrt eine Editoraktion aus und raeumt sie zuverlaessig ab: Bei
   * Erfolg wird gespeichert, bei einem Fehler abgebrochen.
   *
   * Das ist der empfohlene Weg. Eine offen gebliebene Aktion blockiert
   * sonst die Sitzung, und der Fehler zeigt sich erst beim naechsten
   * Kommando - weit entfernt von seiner Ursache.
   */
  async edit<T>(
    start: () => Promise<EdpEditor>,
    work: (editor: EdpEditor) => Promise<T>
  ): Promise<{ result: T; ref: string; num: string }> {
    const editor = await start();
    let result: T;
    try {
      result = await work(editor);
    } catch (error) {
      await editor.cancel();
      throw error;
    }
    const { ref, num } = await editor.commit();
    return { result, ref, num };
  }

  /** Meldet ab und schliesst die Verbindung - gibt die Lizenz frei. */
  async close(): Promise<void> {
    if (this.connection.isClosed) return;
    this.connection.send("END", null);
    try {
      await this.connection.read("END-Bestaetigung", 3000);
    } catch {
      // Der Server darf die Verbindung auch ohne Bestaetigung schliessen.
    }
    this.connection.close();
  }
}

/**
 * Ergaenzt eine Datenmenge um die Feldnamen und eine Objektdarstellung.
 *
 * Die Zuordnung geht ueber die Position, nicht ueber den Namen: Laut
 * Spezifikation liefert der Server je angefordertem Feld genau ein Feld
 * zurueck, "unabhaengig davon, ob das eingetragene Feld gueltig ist oder
 * nicht". Ein Tippfehler im Feldnamen verschiebt die Spalten also nicht -
 * er liefert nur eine leere Spalte.
 */
function withFields(dataset: Dataset, fields: string[] | undefined): Dataset {
  if (!fields || fields.length === 0) return dataset;
  const names = fields.map((name) => name.replace(/^-/, "").trim());
  return {
    ...dataset,
    fields: names,
    records: dataset.rows.map((row) => {
      const record: Record<string, string> = {};
      names.forEach((name, index) => {
        record[name] = row[index] ?? "";
      });
      return record;
    }),
  };
}

/**
 * Wartet auf ACK oder NAK und sammelt unterwegs die E-Saetze ein, weil
 * dort der eigentliche Grund einer Ablehnung steht.
 */
async function expectAck(connection: EdpConnection, action: string): Promise<EdpRecord> {
  const messages: string[] = [];
  for (;;) {
    const record = await connection.read(`${action}-Antwort`);
    if (record.command === "ACK") return record;
    if (record.command === "NAK") throw new EdpError(action, record, messages);
    if (record.command === "E") messages.push(record.fields[0] ?? "");
    if (record.command === "END") {
      throw new EdpError(action, record, messages.length > 0 ? messages : ["Server hat die Sitzung beendet"]);
    }
  }
}
