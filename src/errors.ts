import type { EdpRecord } from "./record";

/**
 * Fehler, den der abas-Server gemeldet hat.
 *
 * Der Grund steckt oft nicht im NAK-Satz: Der traegt haeufig nur eine
 * allgemeine Floskel ("Aktion jetzt nicht möglich"), waehrend der
 * unmittelbar davor gesendete E-Satz den eigentlichen Grund nennt ("LGN:
 * Login Version 2 erwartet CHM als ersten Request."). Deshalb werden die
 * E-Saetze einer Aktion gesammelt und hier mitgefuehrt - ohne sie steht
 * man bei einer Ablehnung ratlos da.
 */
export class EdpError extends Error {
  readonly code: string;
  readonly context: string;
  readonly serverMessages: string[];

  constructor(action: string, nak: EdpRecord, serverMessages: string[] = []) {
    const reason = nak.fields[0] ?? "ohne Angabe";
    const code = nak.fields[1] ?? "";
    const detail = serverMessages.length > 0 ? ` - Grund laut Server: ${serverMessages.join(" / ")}` : "";
    super(`${action} abgelehnt: ${reason}${code ? ` (Fehler ${code})` : ""}${detail}`);
    this.name = "EdpError";
    this.code = code;
    this.context = nak.fields[2] ?? "";
    this.serverMessages = serverMessages;
  }
}

/** Zeitlimit ueberschritten, ohne dass der Server geantwortet hat. */
export class EdpTimeoutError extends Error {
  constructor(timeoutMs: number, waitingFor: string) {
    super(`Zeitlimit: keine Antwort binnen ${timeoutMs} ms (erwartet: ${waitingFor})`);
    this.name = "EdpTimeoutError";
  }
}

/** Die Verbindung wurde geschlossen, waehrend noch etwas erwartet wurde. */
export class EdpConnectionClosedError extends Error {
  constructor(message = "Verbindung wurde geschlossen") {
    super(message);
    this.name = "EdpConnectionClosedError";
  }
}
