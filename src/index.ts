/**
 * @sschweimler/abas-edp
 *
 * Client fuer die EDP-Schnittstelle von abas ERP: ein textbasiertes
 * Protokoll ueber TCP, Standardport 6550, in der abas-Onlinehilfe
 * vollstaendig spezifiziert (Kapitel 300.17). Die Schnittstelle gehoert
 * zum Kernsystem, ist offengelegt und braucht keine Zusatzlizenz - eine
 * Verbindung belegt allerdings wie jeder Zugriff eine Benutzerlizenz.
 *
 * Bewusst ohne Laufzeitabhaengigkeiten: TCP und ISO-8859-1 kann Node
 * selbst. Damit laeuft das Paket ueberall, wo Node laeuft, und ist - im
 * Unterschied zu AJO - nicht an mandantenspezifisch erzeugte
 * Bibliotheken gebunden.
 */

export {
  EdpSession,
  DEFAULT_OPTIONS,
  type LoginOptions,
  type SelectOptions,
  type Dataset,
} from "./session";
export { EdpConnection, type ConnectionOptions, type LogDirection } from "./connection";
export { EdpError, EdpTimeoutError, EdpConnectionClosedError } from "./errors";
export {
  escapeField,
  buildRecord,
  parseRecord,
  appendContinuation,
  MAX_RECORD_BYTES,
  type EdpRecord,
} from "./record";

import { EdpSession, type LoginOptions } from "./session";

/**
 * Bequemer Einstieg: verbindet, meldet an und liefert die Sitzung.
 *
 * Die Sitzung muss mit `close()` beendet werden, damit die belegte Lizenz
 * wieder frei wird.
 */
export function connect(options: LoginOptions): Promise<EdpSession> {
  return EdpSession.open(options);
}
