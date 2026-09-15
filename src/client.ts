import { EdpSession, type LoginOptions } from "./session";
import { Mutex } from "./mutex";

export interface ClientOptions extends LoginOptions {
  /**
   * Zeit ohne Nutzung, nach der die Sitzung abgemeldet wird. 0 schaltet
   * die Abmeldung ab. Vorgabe: 5 Minuten.
   *
   * Der Sinn ist die Lizenz: Eine offene Verbindung belegt sie
   * dauerhaft, auch im Leerlauf. Nach der Abmeldung ist sie frei, und
   * der naechste Zugriff meldet sich neu an (rund eine halbe Sekunde).
   */
  idleTimeoutMs?: number;
}

/**
 * Verwaltet **genau eine** EDP-Sitzung.
 *
 * Bewusst kein Verbindungspool: Jede Anmeldung belegt eine
 * abas-Benutzerlizenz, und diese Anwendung darf nie mehr als eine
 * belegen. Alle Zugriffe laufen deshalb nacheinander ueber dieselbe
 * Sitzung.
 *
 * Die Folge ist unvermeidlich und sollte bekannt sein: Ein lang
 * laufender Aufruf blockiert alle anderen. Ein unfiltertes PRODLIST
 * braucht rund 13 Sekunden - so lange wartet jede andere Anfrage. Wer
 * Durchsatz braucht, muss ihn ueber Zwischenspeichern der Ergebnisse
 * gewinnen, nicht ueber zusaetzliche Sitzungen.
 *
 * Um die Anmeldung kuemmert sich der Client selbst: Er meldet sich beim
 * ersten Zugriff an, nach Leerlauf wieder ab und bei Bedarf neu an.
 */
export class EdpClient {
  private session: EdpSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private readonly mutex = new Mutex();

  constructor(private readonly options: ClientOptions) {}

  get isConnected(): boolean {
    return this.session !== null;
  }

  /**
   * Fuehrt einen Vorgang auf der Sitzung aus - angemeldet wird bei Bedarf.
   *
   * Vorgaenge laufen nacheinander. Die Reihenfolge der Aufrufe bleibt
   * erhalten.
   */
  use<T>(work: (session: EdpSession) => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      if (this.closing) throw new Error("Client ist geschlossen");
      this.stopIdleTimer();
      const session = await this.ensureSession();

      try {
        return await work(session);
      } catch (error) {
        // Ist die Verbindung dabei weggebrochen, die Sitzung verwerfen -
        // der naechste Aufruf meldet sich dann sauber neu an. Der Fehler
        // selbst wird durchgereicht und NICHT stillschweigend wiederholt:
        // Ob ein Schreibvorgang den Server noch erreicht hat, ist von
        // hier aus nicht erkennbar, und eine Wiederholung koennte doppelt
        // schreiben.
        if (this.sessionIsDead()) this.session = null;
        throw error;
      } finally {
        this.startIdleTimer();
      }
    });
  }

  /** Meldet ab und gibt die Lizenz frei. */
  async close(): Promise<void> {
    this.closing = true;
    this.stopIdleTimer();
    await this.mutex.runExclusive(async () => {
      await this.disconnect();
    });
  }

  /**
   * Meldet ab, ohne den Client unbrauchbar zu machen - der naechste
   * Zugriff meldet sich neu an. Fuer Wartungsfaelle.
   */
  async logout(): Promise<void> {
    this.stopIdleTimer();
    await this.mutex.runExclusive(async () => {
      await this.disconnect();
    });
  }

  private async ensureSession(): Promise<EdpSession> {
    if (this.session && !this.sessionIsDead()) return this.session;
    this.session = null;
    this.session = await EdpSession.open(this.options);
    return this.session;
  }

  private sessionIsDead(): boolean {
    return this.session === null || this.session.isClosed;
  }

  private async disconnect(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      await session.close();
    } catch {
      // Beim Abmelden ist ein Fehler ohne Belang - die Verbindung geht
      // so oder so zu, und die Lizenz wird spaetestens serverseitig frei.
    }
  }

  private startIdleTimer(): void {
    const timeout = this.options.idleTimeoutMs ?? 5 * 60 * 1000;
    if (timeout <= 0 || this.closing || !this.session) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // Nicht direkt abmelden, sondern ueber denselben Ausschluss - sonst
      // koennte mitten in einem laufenden Vorgang die Sitzung wegfallen.
      void this.mutex.runExclusive(() => this.disconnect());
    }, timeout);
    // Ein Zeitgeber allein soll den Prozess nicht am Leben halten.
    this.idleTimer.unref?.();
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
