# MCP Tool Usage Rules

## graphify — use FIRST for any code exploration

Before using Grep/Glob/Read to explore the codebase, try the graphify
knowledge graph first. It's faster and gives structural context (callers,
communities, cross-community bridges) that file scanning cannot.

Graph artifacts live in `graphify-out/` (gitignored). Rebuild with
`/graphify .` or `/graphify . --update` (incremental).

| Task | Command |
|---|---|
| Find what connects two concepts | `/graphify path "NodeA" "NodeB"` |
| Explain a node and its neighbors | `/graphify explain "NodeName"` |
| Open-ended question over the graph | `/graphify query "how does X work"` |
| Rebuild after code changes | `/graphify . --update` |
| Full rebuild | `/graphify .` |

Fall back to Grep/Glob/Read only when the graph returns nothing useful
or the question is about literal file contents (imports, strings, syntax).

## Shopify dev MCP — use BEFORE any admin UI changes

Any time you add, edit, or fix a Polaris component or App Bridge interaction
in `app/components/`, `app/routes/app/`, or `app/routes/admin/`:

1. `mcp__shopify-dev-mcp__learn_shopify_api` — load the relevant API context:
   - Admin app UI → `api: "polaris-app-home"`
   - Admin GraphQL mutations/queries → `api: "admin"`
   - Shopify Functions → `api: "functions"`

2. `mcp__shopify-dev-mcp__search_docs_chunks` — search for the specific
   component, prop, event, slot, or mutation you need.

3. Write code that matches the documented API exactly.

**Never guess Polaris component props, event names, slot names, or
show/hide methods.** The last time we guessed (`shopify.modal.show()`,
`showOverlay()` order, `onHide` vs `command="--hide"`), it cost multiple
debugging sessions. The MCP lookup takes 10 seconds.
