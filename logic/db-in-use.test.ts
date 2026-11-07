import { assertEquals } from "jsr:@std/assert@1";
import { dbInUse } from "./db-in-use.ts";

Deno.test("the default when it can be reached", () => {
  assertEquals(dbInUse([{ id: "a", exists: true }, { id: "b", current: true, exists: true }])?.id, "b");
});

Deno.test("a default that cannot be reached: nothing, not another database (critic 2026-11-07, finding 2)", () => {
  assertEquals(dbInUse([{ id: "a", exists: true }, { id: "b", current: true, exists: false }]), undefined);
});

Deno.test("no default set: the first that can be reached", () => {
  assertEquals(dbInUse([{ id: "a", exists: false }, { id: "b", exists: true }, { id: "c", exists: true }])?.id, "b");
});

Deno.test("nothing registered", () => {
  assertEquals(dbInUse([]), undefined);
  assertEquals(dbInUse(undefined), undefined);
});
