"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeField, buildRecord, parseRecord, appendContinuation } = require("../dist/record");

test("maskiert die Sonderzeichen des Protokolls", () => {
  assert.equal(escapeField("a|b"), "a\\|b");
  assert.equal(escapeField("a\nb"), "a\\nb");
  assert.equal(escapeField("a\rb"), "a\\rb");
  assert.equal(escapeField("a\\b"), "a\\\\b");
  assert.equal(escapeField("a\0b"), "a\\0b");
});

test("verdoppelt den Backslash zuerst", () => {
  // Andernfalls wuerde aus "\" erst "\\" und daraus faelschlich "\\\\".
  assert.equal(escapeField("\\|"), "\\\\\\|");
});

test("Maskieren und Zerlegen sind zueinander invers", () => {
  const werte = ["schlicht", "mit|Trenner", "mit\nUmbruch", "mit\\Backslash", "Ø1700x12,6 mm", ""];
  const satz = buildRecord("D", 1, werte);
  const zerlegt = parseRecord(satz);
  assert.deepEqual(zerlegt.fields, werte);
  assert.equal(zerlegt.command, "D");
  assert.equal(zerlegt.tid, "1");
  assert.ok(zerlegt.complete);
});

test("erkennt einen vollstaendigen Satz am abschliessenden Trenner", () => {
  assert.ok(parseRecord("ACK|1|Logon erfolgreich|").complete);
  assert.ok(!parseRecord("D|1|Feld|Fragment").complete);
});

test("Satz ohne Aktions-ID", () => {
  assert.equal(buildRecord("END", null), "END");
});

test("setzt DC-Fortsetzungen zu einem Feld zusammen", () => {
  const zeile = [...parseRecord("D|1|Lieferant|Anfang").fields];
  appendContinuation(zeile, parseRecord("DC|1|-Mitte"));
  appendContinuation(zeile, parseRecord("DC|1|-Ende|1:1|"));
  assert.deepEqual(zeile, ["Lieferant", "Anfang-Mitte-Ende", "1:1"]);
});

test("leere Felder bleiben erhalten", () => {
  const zerlegt = parseRecord("EOD|3|1||0|");
  assert.deepEqual(zerlegt.fields, ["1", "", "0"]);
});
