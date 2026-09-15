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
      return new EdpSession(connection, options.client, ack.fields[0] ?? "");
    } catch (error) {
      connection.destroy();
      throw error;
    }
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
    return this.readDataset(command);
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
