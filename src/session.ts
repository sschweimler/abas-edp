import os from "node:os";
import { EdpConnection, type ConnectionOptions } from "./connection";
import { appendContinuation, type EdpRecord } from "./record";
import { EdpError } from "./errors";

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

  /** Setzt eine Darstellungsoption (SET), z. B. VERWMODE auf "SW". */
  async setOption(name: string, value: string): Promise<void> {
    await this.command("SET", [name, value]);
  }

  /**
   * Fuehrt ein Kommando aus, das mit ACK oder NAK beantwortet wird.
   * Liefert den ACK-Satz.
   */
  async command(command: string, fields: unknown[] = []): Promise<EdpRecord> {
    const tid = this.connection.takeTid();
    this.connection.send(command, tid, fields);
    return expectAck(this.connection, command);
  }

  /**
   * Fuehrt ein Kommando aus, das mit einer Datenmenge beantwortet wird
   * (BOD, beliebig viele D/DC, EOD).
   */
  async query(command: string, fields: unknown[] = []): Promise<Dataset> {
    const tid = this.connection.takeTid();
    this.connection.send(command, tid, fields);
    this.lastQueryTid = tid;
    return this.readDataset(command);
  }

  /**
   * Fuehrt eine Selektion aus (EXQ).
   *
   * Der Selektstring wird in der klassischen Form "Tabelle,Kriterien"
   * zusammengesetzt. Ab EDP 3.55 koennte die Tabelle auch im letzten Feld
   * stehen - die klassische Form funktioniert aber auch mit aelteren
   * Servern, und der Unterschied ist sonst keiner.
   */
  async select(options: SelectOptions): Promise<Dataset> {
    const selectString = options.criteria
      ? `${options.table},${options.criteria}`
      : options.table;
    const fieldList = options.fields?.join(",") ?? "";

    const dataset = await this.query("EXQ", [
      selectString,
      fieldList,
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

  /**
   * Holt die naechste Teilmenge einer Abfrage (GNR).
   *
   * Ohne Aktions-ID setzt der Server die zuletzt benutzte Abfrage fort;
   * hier wird sie trotzdem mitgegeben, damit das Verhalten auch dann
   * eindeutig bleibt, wenn zwischendurch andere Kommandos liefen.
   */
  async next(): Promise<Dataset> {
    if (this.lastQueryTid === null) {
      throw new Error("Kein Weiterlesen moeglich - es wurde noch keine Abfrage ausgefuehrt");
    }
    this.connection.send("GNR", this.lastQueryTid, []);
    const dataset = await this.readDataset("GNR");
    return withFields(dataset, this.lastFields);
  }

  /**
   * Selektiert und liefert alle Saetze, ueber beliebig viele Teilmengen
   * hinweg. Nur verwenden, wenn das Ergebnis in den Speicher passt -
   * sonst select()/next() von Hand paginieren.
   */
  async selectAll(options: SelectOptions): Promise<Dataset> {
    const first = await this.select(options);
    const rows = [...first.rows];
    let page = first;

    while (page.hasMore) {
      page = await this.next();
      rows.push(...page.rows);
    }

    return withFields({ ...first, rows, hasMore: false }, options.fields);
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
            rows,
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
