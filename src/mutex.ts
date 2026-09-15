/**
 * Schlichter asynchroner gegenseitiger Ausschluss.
 *
 * Wird gebraucht, weil eine EDP-Sitzung strikt seriell arbeitet: Es gibt
 * genau einen Antwortstrom, und der laesst sich nicht zwei gleichzeitigen
 * Anfragen zuordnen. Ohne Ausschluss vermischen sich die Antworten, und
 * das ist der unangenehme Fall - nicht ein Fehler, sondern falsche Daten
 * beim falschen Aufrufer.
 */
export class Mutex {
  private kette: Promise<unknown> = Promise.resolve();

  /**
   * Fuehrt `fn` aus, sobald alle vorherigen Aufgaben fertig sind.
   * Die Reihenfolge der Aufrufe bleibt erhalten.
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Auch bei einem Fehler muss die Kette weiterlaufen, sonst blockiert
    // ein einziger Fehlschlag die Sitzung fuer immer.
    const ergebnis = this.kette.then(fn, fn);
    this.kette = ergebnis.then(
      () => undefined,
      () => undefined
    );
    return ergebnis;
  }
}
