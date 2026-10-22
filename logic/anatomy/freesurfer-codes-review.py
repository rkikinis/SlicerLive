# Makes the review page for freesurfer-codes.csv (Contents/docs/freesurfer-codes-review.html in the workspace):
#   python3 -I Contents/src/SlicerLive/logic/anatomy/freesurfer-codes-review.py <out.html>
import csv, html, sys, urllib.parse, os
here = os.path.dirname(os.path.abspath(__file__))
rows = list(csv.DictReader(open(os.path.join(here, "freesurfer-codes.csv"))))
E = html.escape
def ta2link(n): return f'<a href="https://www.wikidata.org/w/index.php?search={urllib.parse.quote("haswbstatement:P7173=" + n)}">{n}</a>' if n else "&mdash;"
def tr(r):
    code = f"{r['scheme']} {r['code']}" if r['code'] else "&mdash;"
    note = "; ".join(x for x in [r['note'], r['ta2Note']] if x)
    return f"<tr><td>{E(r['type'])}</td><td class=c>{code}</td><td>{E(r['meaning'])} <span class=m>{E(r['match'])}</span></td><td class=c>{ta2link(r['ta2'])}</td><td>{E(r['ta2Name'])} <span class=m>{E(r['ta2Match'])}</span></td><td class=n>{E(note)}</td></tr>"
def table(sel): return "<div class=w><table><tr><th>Structure (both sides)</th><th>SNOMED / DICOM</th><th>Its meaning</th><th>TA2</th><th>TA2 term (Wikidata)</th><th>Note</th></tr>" + "".join(tr(r) for r in sel) + "</table></div>"
done = [r for r in rows if r['status'] == 'reviewed']
rest = [r for r in rows if r['status'] != 'reviewed']
order = {'exact': 0, 'nearest': 1, 'parent': 2, 'none': 3}
rest.sort(key=lambda r: (order.get(r['match'], 9), r['source'], r['type']))
page = f"""<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width, initial-scale=1"><title>FreeSurfer Codes Review</title>
<style>:root{{--bg:#15110d;--surface:#2e261e;--fg:#fbf9f5;--muted:#b9ad97;--accent:#f8d764;--line:#3a3128}}
body{{margin:0;background:var(--bg);color:var(--fg);font:13px -apple-system,"Helvetica Neue",Arial,sans-serif;padding:24px 16px 48px}}main{{max-width:1200px;margin:0 auto}}
h1{{font-size:20px}}h2{{font-size:15px;margin:22px 0 6px}}.lede{{color:var(--muted);line-height:1.55;max-width:90ch}}a{{color:var(--accent)}}
.w{{overflow-x:auto}}table{{border-collapse:collapse;width:100%}}td,th{{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top;line-height:1.4}}th{{color:var(--muted)}}
td.c{{white-space:nowrap;font-variant-numeric:tabular-nums}}td.n{{color:var(--muted)}}.m{{color:var(--muted);font-size:11px}}</style></head>
<body><main><h1>Codes for FreeSurfer's structures: for review</h1>
<p class=lede>One row per kind of structure (left and right share it; the side goes in DICOM's laterality modifier). The SNOMED or DICOM code goes into the segmentation file; the TA2 number and term are Albula's own (DICOM has no coding scheme for TA2), for the tooltip and the tree. Every SNOMED code was confirmed active on HL7's terminology server; the TA2 numbers are Wikidata's TA2 property, which is what FIPAT's TA2 Viewer reads (each number links to its Wikidata entry). Only rows marked reviewed reach the app.</p>
<h2>To look at ({len(rest)} rows): exact first, then nearest, parent, none</h2>{table(rest)}
<h2>Decided ({len(done)} rows, reviewed)</h2>{table(done)}
<p class=lede style="font-size:11px">Sources: DICOM PS3.16 CID 7140 and CID 7153; SNOMED CT through HL7's public terminology server (tx.fhir.org); TA2 numbers from Wikidata property P7173 (CC0). The table: <code>Contents/src/SlicerLive/logic/anatomy/freesurfer-codes.csv</code>. Drafted with Claude (Anthropic) for Ron Kikinis.</p>
</main></body></html>"""
open(sys.argv[1], "w").write(page)
print(len(rest), "to look at,", len(done), "decided")
