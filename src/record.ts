/**
 * Satz- und Feldformat des EDP-Protokolls.
 *
 * Belegstellen in der abas-Onlinehilfe:
 *   300.17.2.1  Satzformat  - Feldtrenner "|", Zeilenende Linefeed,
 *                             Satzlaenge maximal 4096 Byte
 *   300.17.2.2  Feldformat  - Maskierung der Sonderzeichen
 *   300.17.2.3  Request Codes, Aufbau "Kommando|Aktions-ID|Feld|..."
 */

/** Groesste zulaessige Satzlaenge inklusive Zeilenende. */
export const MAX_RECORD_BYTES = 4096;

export interface EdpRecord {
  /** Kommando bzw. Request Code, 1-3 Zeichen (LGN, ACK, D, EOD, ...). */
  command: string;
  /** Aktions-ID. Bei Saetzen ohne Aktionsbezug (END) leer. */
  tid: string;
  /** Felder ab Position 3, also ohne Kommando und Aktions-ID. */
  fields: string[];
  /** Alle Felder einschliesslich Kommando und Aktions-ID. */
  allFields: string[];
  /**
   * Ob der Satz vollstaendig ist. Jeder vollstaendige Satz endet mit dem
   * Feldtrenner. Fehlt er, wurde an der 4-KB-Grenze abgeschnitten und das
   * letzte Feld ist ein Fragment, das in einem DC-Satz fortgesetzt wird.
   */
  complete: boolean;
  /** Die empfangene Zeile, unveraendert. */
  raw: string;
}

/**
 * Maskiert einen Feldwert fuer den Versand.
 *
 * Die Reihenfolge ist nicht beliebig: Der Backslash muss zuerst verdoppelt
 * werden, sonst wuerden die anschliessend erzeugten Escape-Sequenzen selbst
 * noch einmal maskiert.
 */
export function escapeField(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0");
}

/** Setzt einen Satz aus Kommando, Aktions-ID und Feldern zusammen. */
export function buildRecord(command: string, tid: number | string | null, fields: unknown[] = []): string {
  if (tid === null) return command;
  return [command, String(tid), ...fields.map(escapeField)].join("|") + "|";
}

/**
 * Zerlegt eine empfangene Zeile in Felder und loest die Maskierung auf.
 *
 * Die Maskierung wird beim Zerlegen aufgeloest, nicht danach - sonst liesse
 * sich ein maskierter Trenner ("\|") nicht mehr von einem echten
 * unterscheiden.
 */
export function parseRecord(line: string): EdpRecord {
  const fields: string[] = [];
  let current = "";
  let endedWithSeparator = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") {
      const next = line[i + 1];
      if (next === "n") current += "\n";
      else if (next === "r") current += "\r";
      else if (next === "0") current += "\0";
      else if (next === "\\") current += "\\";
      else if (next === "|") current += "|";
      else current += next ?? "\\";
      i++;
      endedWithSeparator = false;
      continue;
    }
    if (char === "|") {
      fields.push(current);
      current = "";
      endedWithSeparator = true;
      continue;
    }
    current += char;
    endedWithSeparator = false;
  }
  if (current !== "") fields.push(current);

  return {
    command: fields[0] ?? "",
    tid: fields[1] ?? "",
    fields: fields.slice(2),
    allFields: fields,
    complete: endedWithSeparator,
    raw: line,
  };
}

/**
 * Haengt einen DC-Fortsetzungssatz an die zuletzt begonnene Datenzeile an.
 *
 * Das erste Feld eines DC-Satzes ist kein eigenes Feld, sondern der Rest
 * des abgeschnittenen letzten Feldes der Vorgaengerzeile; es wird direkt
 * angehaengt. Erst die folgenden Felder sind neue Felder. Wer das
 * uebersieht, baut stillschweigend falsche Datensaetze zusammen - der
 * Fehler faellt erst bei langen Feldinhalten auf.
 */
export function appendContinuation(target: string[], continuation: EdpRecord): void {
  const [rest, ...further] = continuation.fields;
  if (target.length === 0) {
    target.push(rest ?? "");
  } else {
    target[target.length - 1] += rest ?? "";
  }
  target.push(...further);
}
