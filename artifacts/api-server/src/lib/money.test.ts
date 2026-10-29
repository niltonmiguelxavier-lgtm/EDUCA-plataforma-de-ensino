import assert from "node:assert/strict";
import { test } from "node:test";
import { canWithdraw, fromCents, percentageToBps, splitCommission, toCents } from "./money";

test("toCents e fromCents convertem sem erros de vírgula flutuante", () => {
  assert.equal(toCents("123.45"), 12345);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(fromCents(12345), "123.45");
  assert.equal(fromCents(5), "0.05");
  assert.equal(fromCents(-250), "-2.50");
  assert.throws(() => toCents("abc"), /INVALID_AMOUNT/);
});

test("splitCommission soma sempre o valor total", () => {
  for (const amount of [1, 99, 100, 12345, 99999]) {
    for (const bps of [0, 1, 500, 1250, 3333, 10000]) {
      const { commissionCents, teacherCents } = splitCommission(amount, bps);
      assert.equal(commissionCents + teacherCents, amount);
      assert.ok(commissionCents >= 0 && teacherCents >= 0);
    }
  }
  assert.deepEqual(splitCommission(10000, 1000), { commissionCents: 1000, teacherCents: 9000 });
});

test("splitCommission rejeita valores inválidos", () => {
  assert.throws(() => splitCommission(0, 1000), /INVALID_AMOUNT/);
  assert.throws(() => splitCommission(100.5, 1000), /INVALID_AMOUNT/);
  assert.throws(() => splitCommission(100, 10001), /INVALID_RATE/);
  assert.throws(() => splitCommission(100, -1), /INVALID_RATE/);
});

test("percentageToBps converte percentagens", () => {
  assert.equal(percentageToBps(12.5), 1250);
  assert.equal(percentageToBps(0), 0);
  assert.throws(() => percentageToBps(101), /INVALID_RATE/);
});

test("canWithdraw respeita o saldo disponível", () => {
  assert.equal(canWithdraw(10000, 10000), true);
  assert.equal(canWithdraw(10000, 10001), false);
  assert.equal(canWithdraw(10000, 0), false);
  assert.equal(canWithdraw(10000, -5), false);
});
