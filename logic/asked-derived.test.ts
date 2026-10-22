// Which derived series was asked for (logic/asked-derived.ts): the tract set ticked in the DICOM browser for a scan.
import { assertEquals } from "jsr:@std/assert@1";
import { askDerived, askedDerived, forgetAskedDerived, forgetAskedDerivedFor, onAskedDerived } from "./asked-derived.ts";

Deno.test("a tract set asked for under a scan is found by kind and scan; the last ask wins; closing forgets", () => {
  forgetAskedDerived();
  assertEquals(askedDerived("tracts", "scanA"), undefined);
  askDerived("tracts", "scanA", "set1");
  askDerived("tracts", "scanB", "set9");
  askDerived("tracts", "scanA", "set2");
  assertEquals(askedDerived("tracts", "scanA"), "set2");
  assertEquals(askedDerived("tracts", "scanB"), "set9");
  assertEquals(askedDerived("surface", "scanA"), undefined, "another kind is another request");
  forgetAskedDerived();
  assertEquals(askedDerived("tracts", "scanA"), undefined);
});

Deno.test("a new ask reaches the listeners once; the same ask again does not; a parent leaving forgets its asks", () => {
  forgetAskedDerived();
  const heard: string[] = [];
  const stop = onAskedDerived((kind, parent, child) => heard.push(`${kind} ${parent} ${child}`));
  askDerived("tracts", "scanA", "set1");
  askDerived("tracts", "scanA", "set1");
  askDerived("tracts", "scanA", "set2");
  assertEquals(heard, ["tracts scanA set1", "tracts scanA set2"]);
  stop();
  askDerived("tracts", "scanA", "set3");
  assertEquals(heard.length, 2, "stopped listeners hear nothing");
  askDerived("tracts", "scanB", "set9");
  forgetAskedDerivedFor("scanA");
  assertEquals(askedDerived("tracts", "scanA"), undefined);
  assertEquals(askedDerived("tracts", "scanB"), "set9");
  forgetAskedDerived();
});
