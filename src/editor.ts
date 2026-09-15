import type { EdpConnection } from "./connection";
import type { EdpRecord } from "./record";
import { EdpError } from "./errors";

/**
 * Angabe einer Zeile im Tabellenteil.
 *
 * - Zahl: Zeilennummer, aendert sich durch Einfuegen/Loeschen
 * - "(1234,2,0,5)": Zeilenreferenz, aendert sich nicht
 * - ".": zuletzt angesprochene Zeile
 * - "#": vor die letzte Zeile
 * - weggelassen oder 0: Kopfteil
 */
export type RowSpec = number | string;

/**
 * Eine offene Editoraktion.
 *
 * Wichtig: Die Aktion traegt eine eigene Aktions-ID, die bei allen
 * folgenden Schritten anzugeben ist, und sie bleibt offen, bis sie mit
 * commit() gespeichert oder mit cancel() verworfen wird. Ein
 * Exklusiveditor laesst in derselben Sitzung keinen zweiten zu - eine
 * vergessene Aktion blockiert also alles Weitere. Deshalb sollte man
 * EdpSession.edit() verwenden, das beides zuverlaessig abraeumt.
 */
export class EdpEditor {
  private finished = false;

  constructor(
    private readonly connection: EdpConnection,
    readonly tid: number
  ) {}

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

  /**
   * Setzt einen Feldwert (SFV). Ohne Zeilenangabe bzw. mit 0 wird ein Feld
   * im Kopfteil gesetzt.
   *
   * Zahlen werden hier NICHT umformatiert. Welche Schreibweise der Server
   * erwartet, haengt an den Darstellungsoptionen der Sitzung: Mit dem
   * voreingestellten NUMMODE=RAW ist es der Dezimalpunkt, unter der
   * abas-Vorgabe waere es das Komma der Bediensprache. Wer die Optionen
   * nicht umstellt, muss seine Werte also selbst passend formatieren.
   */
  async setField(field: string, value: unknown, row: RowSpec = 0): Promise<void> {
    this.ensureOpen();
    this.connection.send("SFV", this.tid, [String(row), field, value]);
    await this.expectAck(`SFV ${field}`);
  }

  /** Fuegt eine leere Zeile ein (RIN). Ohne Angabe am Ende der Tabelle. */
  async insertRow(position?: RowSpec): Promise<void> {
    this.ensureOpen();
    this.connection.send("RIN", this.tid, position === undefined ? [] : [String(position)]);
    await this.expectAck("RIN");
  }

  /** Loescht eine Zeile (RDL). */
  async deleteRow(position: RowSpec): Promise<void> {
    this.ensureOpen();
    this.connection.send("RDL", this.tid, [String(position)]);
    await this.expectAck("RDL");
  }

  /**
   * Liest den Aktionsstatus (GTS) als Zuordnung Eigenschaft -> Wert,
   * z. B. NUMROWS, REF, NUM, ACTION oder MODIFIED.
   *
   * Achtung, am echten System gelernt: GTS antwortet NICHT mit ACK,
   * sondern mit einer Datenmenge - je Eigenschaft eine D-Zeile der Form
   * "D|TID|EIGENSCHAFT|WERT|". Wer hier auf ein ACK wartet, wartet
   * endlos; der Server schweigt einfach.
   */
  async status(): Promise<Record<string, string>> {
    this.connection.send("GTS", this.tid, []);
    const werte: Record<string, string> = {};
    const messages: string[] = [];
    for (;;) {
      const record = await this.connection.read("GTS-Antwort");
      if (record.command === "D") {
        werte[record.fields[0] ?? ""] = record.fields[1] ?? "";
      } else if (record.command === "EOD") {
        return werte;
      } else if (record.command === "NAK") {
        throw new EdpError("GTS", record, messages);
      } else if (record.command === "E") {
        messages.push(record.fields[0] ?? "");
      }
    }
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
   * und eine leere Identnummer, danach die echten Werte, etwa
   * "(182,31,0)" und "30". Am echten System nachgemessen.
   */
  async commit(): Promise<{ ref: string; num: string; message: string }> {
    this.ensureOpen();
    this.connection.send("COM", this.tid, []);
    const ack = await this.expectAck("COM");

    // Die Aktion ist gespeichert; ein fehlgeschlagenes GTS darf das nicht
    // mehr umstossen, deshalb nur der Vollstaendigkeit halber.
    let ref = "";
    let num = "";
    try {
      const status = await this.status();
      ref = status.REF ?? "";
      num = status.NUM ?? "";
    } catch {
      // Referenz bleibt leer - der Datensatz ist trotzdem gespeichert.
    }

    this.finished = true;
    return { ref, num, message: ack.fields[0] ?? "" };
  }

  /** Verwirft die Aktion (CAN). Mehrfaches Aufrufen ist unschaedlich. */
  async cancel(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.connection.send("CAN", this.tid, []);
    try {
      await this.expectAck("CAN");
    } catch {
      // Ein Abbruch, der selbst scheitert, darf den urspruenglichen
      // Fehler nicht verdecken.
    }
  }

  get isFinished(): boolean {
    return this.finished;
  }
}
