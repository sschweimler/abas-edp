import type { EdpConnection } from "./connection";
import type { EdpRecord } from "./record";
import { EdpError } from "./errors";

/**
 * Angabe einer Zeile im Tabellenteil.
 *
 * - Zahl: Zeilennummer, aendert sich durch Einfuegen/Loeschen
 * - "(1234,2,0,5)": Zeilenreferenz, aendert sich nicht
 * - ".": zuletzt angesprochene Zeile
 * - "#": letzte Zeile
 * - "*": alle Zeilen (nur beim Lesen)
 * - weggelassen oder 0: Kopfteil
 */
export type RowSpec = number | string;

/**
 * Eine von GFV gelieferte Zeile.
 *
 * Die Zeilennummer wird mitgegeben, weil sie kein Beiwerk ist: Ohne sie
 * laesst sich ein gelesener Wert spaeter nicht wieder zurueckschreiben.
 * Fuer Kopffelder ist sie "0".
 */
export interface FieldRow {
  row: string;
  fields: Record<string, string>;
}

/**
 * Eine offene Editoraktion - auch ein geoeffnetes Infosystem ist eine.
 *
 * Wichtig: Die Aktion traegt eine eigene Aktions-ID, die bei allen
 * folgenden Schritten anzugeben ist, und sie bleibt offen, bis sie mit
 * commit() gespeichert oder mit cancel() verworfen wird. Ein
 * Exklusiveditor laesst in derselben Sitzung keinen zweiten zu - eine
 * vergessene Aktion blockiert also alles Weitere. Deshalb sollte man
 * EdpSession.edit() verwenden, das beides zuverlaessig abraeumt.
 *
 * Jede oeffentliche Methode belegt die Verbindung exklusiv, solange sie
 * sendet und auf ihre Antwort wartet. Die internen ...Raw-Varianten tun
 * das nicht - sie werden von Methoden aufgerufen, die den Ausschluss
 * bereits halten.
 */
export class EdpEditor {
  private finished = false;

  constructor(
    private readonly connection: EdpConnection,
    readonly tid: number
  ) {}

  get isFinished(): boolean {
    return this.finished;
  }

  private ensureOpen(): void {
    if (this.finished) {
      throw new Error("Editoraktion ist bereits abgeschlossen");
    }
  }

  private async expectAck(action: string): Promise<EdpRecord> {
    const messages: string[] = [];
    for (;;) {
      const record = await this.connection.read(`${action}-Antwort`);
      if (record.command === "ACK") return record;
      if (record.command === "NAK") throw new EdpError(action, record, messages);
      if (record.command === "E") messages.push(record.fields[0] ?? "");
    }
  }

  // --- interne Varianten ohne Ausschluss ---------------------------------

  private async setFieldRaw(field: string, value: unknown, row: RowSpec): Promise<void> {
    this.ensureOpen();
    this.connection.send("SFV", this.tid, [String(row), field, value]);
    await this.expectAck(`SFV ${field}`);
  }

  private async statusRaw(): Promise<Record<string, string>> {
    this.connection.send("GTS", this.tid, []);
    const werte: Record<string, string> = {};
    const messages: string[] = [];
    for (;;) {
      const record = await this.connection.read("GTS-Antwort");
      if (record.command === "D") {
        const [name, wert] = record.fields;
        if (name) werte[name] = this.connection.normalize(wert);
      } else if (record.command === "EOD") {
        return werte;
      } else if (record.command === "NAK") {
        throw new EdpError("GTS", record, messages);
      } else if (record.command === "E") {
        messages.push(record.fields[0] ?? "");
      }
    }
  }

  // --- oeffentliche Schnittstelle ----------------------------------------

  /**
   * Setzt einen Feldwert (SFV). Ohne Zeilenangabe bzw. mit 0 wird ein Feld
   * im Kopfteil gesetzt.
   *
   * Zahlen werden hier NICHT umformatiert. Welche Schreibweise der Server
   * erwartet, haengt an den Darstellungsoptionen der Sitzung: Mit dem
   * voreingestellten NUMMODE=RAW ist es der Dezimalpunkt, unter der
   * abas-Vorgabe waere es das Komma der Bediensprache.
   */
  setField(field: string, value: unknown, row: RowSpec = 0): Promise<void> {
    return this.connection.exclusive(() => this.setFieldRaw(field, value, row));
  }

  /**
   * Betaetigt einen Button.
   *
   * Buttons sind in abas gewoehnliche Felder; geklickt wird, indem man
   * sie setzt. Das mitgelieferte edpinfosys.sh macht es genauso ("Für
   * Buttons müssen keine Feldwerte angegeben werden").
   *
   * Nicht fuer Submaskenbuttons der Arten BU8/BU10/BU12 - die lassen sich
   * nicht klicken, dafuer gibt es das Kommando SUB.
   */
  click(button: string, row: RowSpec = 0): Promise<void> {
    return this.connection.exclusive(() => this.setFieldRaw(button, "", row));
  }

  /**
   * Liest Feldwerte (GFV).
   *
   * Ohne Zeilenangabe kommen die Felder des Kopfteils, mit "*" alle
   * Zeilen des Tabellenteils; moeglich sind ausserdem Zeilennummern,
   * Bereiche wie "1-5", Listen wie "1;#" und $-Selektionen.
   *
   * Der Server antwortet je FELD mit einer Zeile - nicht je Datensatz:
   * "D|TID|Zeile|Feldname|aktueller Wert|urspruenglicher Wert|...".
   * Hier werden sie nach Zeilennummer gruppiert, sodass pro Tabellenzeile
   * ein Objekt entsteht. Die uebrigen Angaben je Feld (aenderbar,
   * Pflichtfeld, Art, Laenge) werden derzeit verworfen.
   */
  getFields(fields?: string[], row?: RowSpec): Promise<FieldRow[]> {
    return this.connection.exclusive(async () => {
      this.ensureOpen();
      this.connection.send("GFV", this.tid, [
        row === undefined ? "" : String(row),
        fields?.join(",") ?? "",
      ]);

      const zeilen = new Map<string, FieldRow>();
      const messages: string[] = [];
      for (;;) {
        const record = await this.connection.read("GFV-Antwort");
        if (record.command === "D") {
          const [zeile, feld, wert] = record.fields;
          const schluessel = zeile ?? "";
          let ziel = zeilen.get(schluessel);
          if (!ziel) {
            ziel = { row: schluessel, fields: {} };
            zeilen.set(schluessel, ziel);
          }
          if (feld) ziel.fields[feld] = this.connection.normalize(wert);
        } else if (record.command === "EOD") {
          return [...zeilen.values()];
        } else if (record.command === "NAK") {
          throw new EdpError("GFV", record, messages);
        } else if (record.command === "E") {
          messages.push(record.fields[0] ?? "");
        }
      }
    });
  }

  /** Fuegt eine leere Zeile ein (RIN). Ohne Angabe am Ende der Tabelle. */
  insertRow(position?: RowSpec): Promise<void> {
    return this.connection.exclusive(async () => {
      this.ensureOpen();
      this.connection.send("RIN", this.tid, position === undefined ? [] : [String(position)]);
      await this.expectAck("RIN");
    });
  }

  /** Loescht eine Zeile (RDL). */
  deleteRow(position: RowSpec): Promise<void> {
    return this.connection.exclusive(async () => {
      this.ensureOpen();
      this.connection.send("RDL", this.tid, [String(position)]);
      await this.expectAck("RDL");
    });
  }

  /**
   * Liest den Aktionsstatus (GTS) als Zuordnung Eigenschaft -> Wert,
   * z. B. NUMROWS, REF, NUM, ACTION oder MODIFIED.
   *
   * Achtung, am echten System gelernt: GTS antwortet NICHT mit ACK,
   * sondern mit einer Datenmenge - je Eigenschaft eine D-Zeile. Wer hier
   * auf ein ACK wartet, wartet endlos; der Server schweigt einfach.
   */
  status(): Promise<Record<string, string>> {
    return this.connection.exclusive(() => this.statusRaw());
  }

  /** Einzelne Eigenschaft aus dem Aktionsstatus. */
  async statusOf(property: string): Promise<string> {
    return (await this.status())[property] ?? "";
  }

  /**
   * Speichert (COM) und liefert Referenz und Identnummer des Datensatzes.
   *
   * Die ACK-Antwort des COM enthaelt nur "Daten erfolgreich gespeichert" -
   * die Referenz steht dort nicht. Sie kommt aus einem GTS unmittelbar
   * danach: Bei einer Neuanlage liefert GTS vor dem Speichern "(0,0,0)"
   * und eine leere Identnummer, danach die echten Werte. Am echten System
   * nachgemessen.
   *
   * Speichern und Nachlesen laufen in EINEM exklusiven Vorgang, damit
   * zwischen COM und GTS nichts dazwischenfunkt.
   */
  commit(): Promise<{ ref: string; num: string; message: string }> {
    return this.connection.exclusive(async () => {
      this.ensureOpen();
      this.connection.send("COM", this.tid, []);
      const ack = await this.expectAck("COM");

      let ref = "";
      let num = "";
      try {
        const status = await this.statusRaw();
        ref = status.REF ?? "";
        num = status.NUM ?? "";
      } catch {
        // Der Datensatz ist gespeichert; ein fehlgeschlagenes Nachlesen
        // darf das nicht mehr umstossen.
      }

      this.finished = true;
      return { ref, num, message: ack.fields[0] ?? "" };
    });
  }

  /** Verwirft die Aktion (CAN). Mehrfaches Aufrufen ist unschaedlich. */
  cancel(): Promise<void> {
    if (this.finished) return Promise.resolve();
    this.finished = true;
    return this.connection.exclusive(async () => {
      this.connection.send("CAN", this.tid, []);
      try {
        await this.expectAck("CAN");
      } catch {
        // Ein Abbruch, der selbst scheitert, darf den urspruenglichen
        // Fehler nicht verdecken.
      }
    });
  }
}
