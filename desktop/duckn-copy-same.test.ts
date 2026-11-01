// A copy made by earlier code that writes the same bytes counts as current; any other code does not (duckn-copy-same.ts).
import { assertEquals } from "jsr:@std/assert@1";
import { COPY_CODE_SAME, sameCopyCode } from "./duckn-copy-same.ts";

Deno.test("copies of equivalent earlier code count; others do not; the steps are followed and cannot loop", () => {
  const [old, { same }] = Object.entries(COPY_CODE_SAME)[0];
  assertEquals(sameCopyCode(same, same), true);
  assertEquals(sameCopyCode(old, same), true);
  assertEquals(sameCopyCode(same, old), false, "only forward: newer copies do not count for older code");
  assertEquals(sameCopyCode("albula-duckn-0-old", same), false);
  assertEquals(sameCopyCode(undefined, same), false);
  for (const [k, v] of Object.entries(COPY_CODE_SAME)) {
    assertEquals(/^albula-duckn-\d+-[0-9a-f]{12}$/.test(k) && /^albula-duckn-\d+-[0-9a-f]{12}$/.test(v.same), true, k);
    assertEquals(v.why.length > 40, true, `${k}: an entry says how the sameness was shown`);
  }
});
