import net from "node:net";
import { Mutex } from "./mutex";
import { buildRecord, parseRecord, MAX_RECORD_BYTES, type EdpRecord } from "./record";
import { EdpConnectionClosedError, EdpTimeoutError } from "./errors";

/** Richtung eines protokollierten Satzes. */
export type LogDirection = "send" | "receive" | "info";

export interface ConnectionOptions {
  host: string;
  /** EDP-Standardport laut Spezifikation. */
  port?: number;
  /** Zeitlimit je erwarteter Antwort. */
  timeoutMs?: number;
  /**
   * Mitschnitt des Protokollverkehrs. Passwoerter sind bereits entfernt,
   * bevor der Text hier ankommt - der Mitschnitt darf weitergereicht
   * werden.
   */
  logger?: (direction: LogDirection, text: string) => void;
  /**
   * Umschliessende Leerzeichen aus gelesenen Feldwerten entfernen.
   * Vorgabe: true.
   *
   * abas liefert Verweise in der Externdarstellung auf Feldbreite
   * aufgefuellt, etwa "        1479" statt "1479". Das ist eine
   * Darstellungsbreite, kein Inhalt - unbehandelt scheitert aber jeder
   * Vergleich und jede Weiterverarbeitung daran.
   *
   * Anders als NUMMODE & Co. ist das KEINE Servereinstellung, sondern
   * eine Normalisierung dieses Pakets. Wer die Rohwerte braucht, setzt
   * die Option auf false.
   */
  trimValues?: boolean;
}

interface Waiting {
  resolve: (record: EdpRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Ein Vorgang, der die Verbindung exklusiv braucht.
 *
 * Eine EDP-Sitzung hat genau einen Antwortstrom. Ein Vorgang besteht aber
 * aus Senden UND Lesen bis zum Abschlusssatz - laufen zwei davon
 * ineinander, bekommt der falsche Aufrufer die Antwort. Deshalb umschliesst
 * jeder oeffentliche Aufruf seinen Vorgang mit exclusive().
 */
export type Operation<T> = () => Promise<T>;

/**
 * Rohe EDP-Verbindung: TCP, Satzgrenzen, Zeichenkodierung, Aktions-IDs.
 *
 * Kennt bewusst keine Kommandos - was LGN oder GTN bedeuten, weiss erst
 * die Session-Schicht darueber. Diese Klasse ist dafuer zustaendig, dass
 * Saetze unversehrt hinein- und herauskommen.
 */
export class EdpConnection {
  private socket: net.Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: EdpRecord[] = [];
  /**
   * Wartende Leser, in Reihenfolge. Frueher stand hier ein einzelner
   * Platz - ein zweiter Leser hat den ersten ueberschrieben, dessen
   * Versprechen nie erfuellt wurde und der ins Zeitlimit lief, waehrend
   * seine Antwort beim Falschen landete.
   */
  private waiting: Waiting[] = [];
  private closed = false;
  private nextTid = 1;
  private readonly mutex = new Mutex();

  constructor(private readonly options: ConnectionOptions) {}

  /**
   * Fuehrt einen vollstaendigen Vorgang (senden und lesen bis zum
   * Abschlusssatz) exklusiv aus. Gleichzeitige Aufrufe werden
   * nacheinander abgearbeitet, nicht vermischt.
   */
  exclusive<T>(operation: Operation<T>): Promise<T> {
    return this.mutex.runExclusive(operation);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Normalisiert einen gelesenen Feldwert (siehe ConnectionOptions.trimValues). */
  normalize(value: string | undefined): string {
    const text = value ?? "";
    return this.options.trimValues === false ? text : text.trim();
  }

  /** Vergibt die naechste Aktions-ID. */
  takeTid(): number {
    return this.nextTid++;
  }

  private log(direction: LogDirection, text: string): void {
    this.options.logger?.(direction, text);
  }

  connect(): Promise<void> {
    const { host, port = 6550 } = this.options;
    return new Promise((resolve, reject) => {
      this.log("info", `verbinde zu ${host}:${port}`);
      const socket = net.createConnection({ host, port }, () => {
        this.log("info", "TCP-Verbindung steht");
        resolve();
      });
      this.socket = socket;
      socket.on("data", (chunk) => this.ingest(chunk));
      socket.on("error", (error) => {
        this.failWaiting(error);
        reject(error);
      });
      socket.on("close", () => {
        this.closed = true;
        this.log("info", "Verbindung geschlossen");
        this.failWaiting(new EdpConnectionClosedError());
      });
    });
  }

  private failWaiting(error: Error): void {
    const wartende = this.waiting;
    this.waiting = [];
    for (const w of wartende) {
      clearTimeout(w.timer);
      w.reject(error);
    }
  }

  /**
   * Zerlegt den Bytestrom in Saetze.
   *
   * Dekodiert wird als latin1 (ISO-8859-1), der Standard des Protokolls -
   * das kann Node ohne Zusatzbibliothek, was diesen ganzen Ansatz erst
   * abhaengigkeitsfrei macht. Ein Carriage Return vor dem Linefeed wird
   * verworfen, weil beide Seiten CRLF senden duerfen.
   */
  private ingest(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index: number;
    while ((index = this.buffer.indexOf(0x0a)) !== -1) {
      let rawLine = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d) {
        rawLine = rawLine.subarray(0, rawLine.length - 1);
      }
      const line = rawLine.toString("latin1");
      this.log("receive", line);
      const record = parseRecord(line);
      const waiting = this.waiting.shift();
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.resolve(record);
      } else {
        this.queue.push(record);
      }
    }
  }

  /** Sendet einen Satz. `tid` null erzeugt einen Satz ohne Aktions-ID (END). */
  send(command: string, tid: number | string | null, fields: unknown[] = [], redactFieldIndex?: number): void {
    const line = buildRecord(command, tid, fields);
    if (Buffer.byteLength(line, "latin1") + 1 > MAX_RECORD_BYTES) {
      throw new Error(
        `Satz laenger als ${MAX_RECORD_BYTES} Byte - Fortsetzungssaetze beim Senden sind nicht umgesetzt`
      );
    }
    // Das Passwort darf nicht in den Mitschnitt geraten. Es steht immer an
    // einer festen Feldposition, die der Aufrufer benennt.
    if (redactFieldIndex !== undefined) {
      const parts = line.split("|");
      const position = redactFieldIndex + 2; // Kommando + Aktions-ID davor
      if (parts[position] !== undefined) parts[position] = "***";
      this.log("send", parts.join("|"));
    } else {
      this.log("send", line);
    }
    this.socket?.write(Buffer.from(line + "\n", "latin1"));
  }

  /** Liest den naechsten Satz - aus der Warteschlange oder vom Netz. */
  read(waitingFor = "Antwort", timeoutMs = this.options.timeoutMs ?? 30000): Promise<EdpRecord> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(new EdpConnectionClosedError());
    return new Promise((resolve, reject) => {
      const eintrag: Waiting = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(eintrag);
          if (index !== -1) this.waiting.splice(index, 1);
          reject(new EdpTimeoutError(timeoutMs, waitingFor));
        }, timeoutMs),
      };
      this.waiting.push(eintrag);
    });
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) this.socket.end();
  }

  destroy(): void {
    this.socket?.destroy();
  }
}
