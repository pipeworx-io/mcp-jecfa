# JECFA — Food Additive Safety Evaluations (WHO/FAO)

Safety evaluations from the Joint FAO/WHO Expert Committee on Food Additives: Acceptable Daily Intakes (ADIs), the committee's conclusions, dietary-exposure findings, and the meeting reports and toxicological monographs behind them — for food additives, flavourings, food contaminants and veterinary drug residues.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

JECFA is the body whose ADI a regulator cites when it sets a limit. This pack answers *"has this substance been evaluated, and what intake did the committee judge acceptable"* — not *"is it permitted in yogurt in the EU"*, which is the Codex GSFA / national-regulator question.

## Tools

| Tool | What it answers |
|---|---|
| `jecfa_search` | Look up by substance name, CAS number, or INS/E-number → ADI, CAS, functional class, chemical id |
| `jecfa_chemical` | Full record for one id: synonyms, INS, and every evaluation JECFA has made — year, ADI, conclusions, intake findings, meeting number, TRS report, tox monograph |
| `jecfa_by_functional_class` | Every substance in a class (sweetener, preservative, colour…) or in one of the four groups |
| `jecfa_functional_classes` | The 71-class vocabulary, so a caller knows the exact name to pass |
| `jecfa_by_number` | Resolve a FEMA or JECFA substance number |
| `jecfa_recent_evaluations` | What the committee has looked at most recently |

## Coverage

3,245 substances: 777 food additives, 2,289 flavouring agents, 115 veterinary drugs, 64 food contaminants. Evaluations run from the committee's earliest meetings to the present — aspartame, for instance, carries evaluations from 1981 through the 2023 re-evaluation at meeting 96.

## Auth

None. Keyless, no registration, no quota.

## Data sources

- Database: <https://apps.who.int/food-additives-contaminants-jecfa-database/>
- About JECFA: <https://www.fao.org/food-safety/scientific-advice/jecfa/en/>

The database has **no documented API**. The endpoints this pack calls are the ones backing the site's own Kendo grid, read off the page. They are undocumented and unversioned, so they can drift without notice; the pack's own gotcha comments (top of `src/index.ts`) record the shapes that were verified live.

## Gotchas

Five upstream behaviours produce confidently wrong answers if taken at face value. All are guarded in the pack, but they matter if you extend it:

1. **`/SearchChemical/ByPartialName` fabricates a row.** It prepends your query string as a result with `Id: 0` and a blank ADI — the UI's "search for this literal text" affordance. Pass it through and you have invented a substance that was never evaluated. The pack drops every row with `Id <= 0`.

2. **The same endpoint returns `CAS_NO: null` even when you searched by CAS.** Searching `50-70-4` correctly finds SORBITOL, then reports its CAS as null. Only `/ChemicalData/GetBy/par/` returns populated records, which is what `jecfa_search` actually calls.

3. **`/ChemicalData/GetBy/fir/` wants the character, not the id.** Its companion `/FilterData/Get/FirstCharacter` hands you `{"Id": 65, "Name": "A"}`; passing `65` returns HTTP 500, passing `A` returns 501 rows.

4. **INS/E-numbers are not searchable at all.** `ByPartialName/951` returns zero rows — INS numbers exist only on the server-rendered detail page. So `jecfa_search` resolves them through `INS_INDEX`, a build-time harvest of all 777 additive detail pages (486 carry an INS). Regenerate with `node mcps/jecfa/scripts/build-ins-index.mjs` after a meeting adds substances.

5. **Detail-page citation rows use a different CSS class than every other field.** ADI, comments, intake and meeting render in `col-sm-8`; the Report, Tox Monograph and Specification rows render in `col-**md**-8` and wrap their text in an `<a>`. A parser matching only `col-sm-8` returns `null` for all three — which reads as "JECFA published no report for this evaluation" when in fact the link to the TRS PDF was right there. The `url` on each citation is upstream's own, usually a direct PDF on `iris.who.int`.

   Bare INS numbers are genuinely ambiguous — INS 160 denotes 19 separately evaluated carotenes — so the index maps each key to a **list** and `jecfa_search` returns every candidate with `ambiguous: true` rather than picking one. Upstream writes sub-forms inconsistently (`100(i)` and `100i` both occur), so keys are normalized to alphanumerics; the generator and the pack must keep using the same normalization or every lookup silently misses.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "jecfa": {
      "url": "https://gateway.pipeworx.io/jecfa/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/jecfa/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/jecfa_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"aspartame"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/jecfa_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "jecfa": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-jecfa"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-jecfa
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Jecfa data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
